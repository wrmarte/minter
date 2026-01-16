// services/adrianSweepEngine.js
// ======================================================
// ADRIAN → ENGINE Sweep Power (BALANCE-BASED)
// ------------------------------------------------------
// Source of truth:
//   Sweep Power = ERC-20 balanceOf(ENGINE_CA)
//
// - Polls ADRIAN token balance for ENGINE_CA
// - Stores a GLOBAL snapshot on client.sweepPowerSnapshot
// - Survives restarts (always initializes from chain)
// - Optional delta for hype only (not required)
// - OPTIONAL DB leader lock (prevents multi-instance polling)
// - Safe RPC via providerM (with fallback)
// - Load-minimized: no overlapping polls + jitter + backoff
// ======================================================

const { ethers } = require("ethers");
const { safeRpcCall, getProvider } = require("./providerM");

/* ======================================================
   REQUIRED ENVS
====================================================== */
const ADRIAN_TOKEN_CA =
  (process.env.ADRIAN_TOKEN_CA ||
    "0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea").toLowerCase();

const ENGINE_CA =
  (process.env.ENGINE_CA ||
    "0x0351f7cba83277e891d4a85da498a7eacd764d58").toLowerCase();

/* ======================================================
   OPTIONAL ENVS
====================================================== */
// Master enable switch (default ON)
const ENABLED =
  String(process.env.ENABLE_ADRIAN_SWEEP_ENGINE ?? "1").trim() === "1";

// Chain selection (safe normalize)
const RAW_CHAIN = process.env.SWEEP_ENGINE_CHAIN ?? "base";

// Polling (default bumped to 30s to reduce load)
const POLL_MS_RAW = Number(process.env.SWEEP_ENGINE_POLL_MS || 30000);
const POLL_MS = Math.max(
  8000,
  Number.isFinite(POLL_MS_RAW) ? POLL_MS_RAW : 30000
);

// Optional jitter to avoid synchronized polling across restarts/instances
const JITTER_MS = Math.max(0, Number(process.env.SWEEP_ENGINE_JITTER_MS || 750));

// Optional DB leader lock to prevent multi-instance polling
const USE_LEADER_LOCK =
  String(process.env.SWEEP_ENGINE_USE_LEADER_LOCK ?? "1").trim() === "1";
// Change this if you want a different lock namespace
const LEADER_LOCK_KEY = Number(process.env.SWEEP_ENGINE_LOCK_KEY || 917301); // int32-ish key

const DEBUG = String(process.env.SWEEP_ENGINE_DEBUG || "").trim() === "1";

// fallback RPC if providerM is unavailable
const FALLBACK_RPC = process.env.SWEEP_ENGINE_BASE_RPC_URL || null;

// Optional: per-call timeout just for sweep engine calls
const SWEEP_RPC_TIMEOUT_MS = Math.max(
  6000,
  Number(process.env.SWEEP_ENGINE_RPC_TIMEOUT_MS || 12000)
);

/* ======================================================
   ERC-20 ABI (MINIMAL)
====================================================== */
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

/* ======================================================
   INTERNAL STATE
====================================================== */
let _running = false;
let _stopped = false;
let _looping = false;
let _timer = null;

/* ======================================================
   HELPERS
====================================================== */
function log(...args) {
  if (DEBUG) console.log("🧹 [SweepEngine]", ...args);
}

function normalizeChain(v) {
  // Handles string OR accidental object values
  const raw =
    (v && typeof v === "object" && (v.chain || v.name || v.network)) ||
    v ||
    "base";
  return String(raw).trim().toLowerCase() || "base";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withJitter(ms) {
  const j = JITTER_MS > 0 ? Math.floor(Math.random() * JITTER_MS) : 0;
  return Math.max(1000, ms + j);
}

async function tryAcquireLeaderLock(client) {
  if (!USE_LEADER_LOCK) return true; // allow running
  const pg = client?.pg;
  if (!pg?.query) return true; // no DB available, just run

  try {
    // Use a single advisory lock key for the whole engine (global)
    const r = await pg.query("SELECT pg_try_advisory_lock($1) AS ok", [
      LEADER_LOCK_KEY,
    ]);
    return Boolean(r.rows?.[0]?.ok);
  } catch (e) {
    // If lock fails, we still allow running (don't brick the bot)
    console.warn("⚠️ [SweepEngine] leader lock check failed:", e?.message || e);
    return true;
  }
}

async function resolveProvider(chainName) {
  // 1) Prefer providerM pinned provider (fast)
  try {
    if (typeof getProvider === "function") {
      const p = getProvider(chainName);
      if (p) return p;
    }
  } catch (_) {}

  // 2) If not pinned yet, try to force selection via safeRpcCall (calls selectHealthy internally)
  try {
    const p = await safeRpcCall(
      chainName,
      async (prov) => prov,
      2,
      SWEEP_RPC_TIMEOUT_MS
    );
    if (p) return p;
  } catch (_) {}

  // 3) Fallback RPC (optional)
  if (!FALLBACK_RPC) {
    throw new Error(
      "No provider available for sweep engine (no providerM pinned + no fallback RPC)"
    );
  }

  return new ethers.JsonRpcProvider(FALLBACK_RPC);
}

/* ======================================================
   CORE: FETCH BALANCE
====================================================== */
async function fetchEngineBalance(chainName, token) {
  // ✅ FIX: correct safeRpcCall signature
  return safeRpcCall(
    chainName,
    async () => {
      const bal = await token.balanceOf(ENGINE_CA);
      return bal;
    },
    3,
    SWEEP_RPC_TIMEOUT_MS
  );
}

/* ======================================================
   INITIALIZE SNAPSHOT (ON BOOT)
====================================================== */
async function initSweepPower(client, chainName, token, decimals) {
  const balRaw = await fetchEngineBalance(chainName, token);
  const bal = Number(ethers.formatUnits(balRaw, decimals));

  client.sweepPowerSnapshot = {
    balanceRaw: balRaw,
    balance: bal,
    lastBalance: null,
    delta: 0,
    updatedAt: new Date(),
  };

  console.log(`🧹 Sweep Power initialized → ${bal.toLocaleString()} ADRIAN`);
}

/* ======================================================
   POLL LOOP (NO OVERLAP)
====================================================== */
async function pollSweepPower(client, chainName, token, decimals) {
  const balRaw = await fetchEngineBalance(chainName, token);
  const bal = Number(ethers.formatUnits(balRaw, decimals));

  const prev = client.sweepPowerSnapshot;
  const lastBalance = prev ? prev.balance : null;
  const delta = lastBalance !== null ? bal - lastBalance : 0;

  client.sweepPowerSnapshot = {
    balanceRaw: balRaw,
    balance: bal,
    lastBalance,
    delta,
    updatedAt: new Date(),
  };

  log("Balance updated:", bal, "Δ", delta >= 0 ? `+${delta}` : delta);
}

/* ======================================================
   PUBLIC STARTER
====================================================== */
async function startSweepEngine(client) {
  if (_running) return;
  _running = true;
  _stopped = false;

  if (!ENABLED) {
    console.log(
      "🧹 ADRIAN Sweep Power Engine: disabled by ENABLE_ADRIAN_SWEEP_ENGINE=0"
    );
    return;
  }

  const chainName = normalizeChain(RAW_CHAIN);

  // Optional leader lock (prevents multi-instance polling)
  const leaderOk = await tryAcquireLeaderLock(client);
  if (!leaderOk) {
    console.log(
      "🧹 ADRIAN Sweep Power Engine: another instance holds leader lock — this instance will not poll."
    );
    return;
  }

  console.log("🧹 Starting ADRIAN Sweep Power Engine (BALANCE MODE)");

  let provider;
  try {
    provider = await resolveProvider(chainName);
  } catch (e) {
    console.warn("🧹 Sweep engine: provider resolve failed:", e?.message || e);
    return;
  }

  const token = new ethers.Contract(ADRIAN_TOKEN_CA, ERC20_ABI, provider);

  // ✅ FIX: correct safeRpcCall signature
  const decimals = await safeRpcCall(
    chainName,
    async () => token.decimals(),
    2,
    SWEEP_RPC_TIMEOUT_MS
  ).catch(() => 18);

  const symbol = await safeRpcCall(
    chainName,
    async () => token.symbol(),
    2,
    SWEEP_RPC_TIMEOUT_MS
  ).catch(() => "TOKEN");

  console.log(
    `🧹 Token loaded → ${symbol} | Decimals: ${decimals} | chain=${chainName}`
  );

  // Always initialize from chain
  try {
    await initSweepPower(client, chainName, token, decimals);
  } catch (e) {
    console.warn("🧹 Sweep engine init failed:", e?.message || e);
  }

  // Self-scheduling loop to prevent overlap + add backoff on errors
  let backoffMs = 0;

  const loop = async () => {
    if (_stopped) return;
    if (_looping) return; // extra safety
    _looping = true;

    try {
      await pollSweepPower(client, chainName, token, decimals);
      backoffMs = 0; // reset on success
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn("🧹 Sweep poll error:", msg);

      // basic backoff (caps at 2 minutes)
      backoffMs = Math.min(
        120000,
        Math.max(5000, (backoffMs || 0) * 2 || 5000)
      );
    } finally {
      _looping = false;

      const next = withJitter(POLL_MS + backoffMs);
      _timer = setTimeout(loop, next);
    }
  };

  // Start after a small jitter to avoid boot spikes
  _timer = setTimeout(loop, withJitter(1000));
}

/* ======================================================
   PUBLIC STOPPER (OPTIONAL)
====================================================== */
function stopSweepEngine() {
  _stopped = true;
  if (_timer) clearTimeout(_timer);
  _timer = null;
  _running = false;
  _looping = false;
}

module.exports = {
  startSweepEngine,
  stopSweepEngine,
};

