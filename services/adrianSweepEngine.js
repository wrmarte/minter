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
const ENABLED = String(process.env.ENABLE_ADRIAN_SWEEP_ENGINE ?? "1").trim() === "1";

// Chain selection (safe normalize)
const RAW_CHAIN = process.env.SWEEP_ENGINE_CHAIN ?? "base";

// Polling (default bumped to 30s to reduce load)
const POLL_MS_RAW = Number(process.env.SWEEP_ENGINE_POLL_MS || 30000);
const POLL_MS = Math.max(8000, Number.isFinite(POLL_MS_RAW) ? POLL_MS_RAW : 30000);

// Optional jitter to avoid synchronized polling across restarts/instances
const JITTER_MS = Math.max(0, Number(process.env.SWEEP_ENGINE_JITTER_MS || 750));

// Optional DB leader lock to prevent multi-instance polling
const USE_LEADER_LOCK = String(process.env.SWEEP_ENGINE_USE_LEADER_LOCK ?? "1").trim() === "1";
// Change this if you want a different lock namespace
const LEADER_LOCK_KEY = Number(process.env.SWEEP_ENGINE_LOCK_KEY || 917301); // int32-ish key

const DEBUG = String(process.env.SWEEP_ENGINE_DEBUG || "").trim() === "1";

// fallback RPC if providerM is unavailable
const FALLBACK_RPC = process.env.SWEEP_ENGINE_BASE_RPC_URL || null;

// RPC call timeouts (reduce false timeouts on busy RPCs)
const CALL_TIMEOUT_MS = Math.max(4000, Number(process.env.SWEEP_ENGINE_CALL_TIMEOUT_MS || 12000));
const CALL_RETRIES = Math.max(1, Number(process.env.SWEEP_ENGINE_CALL_RETRIES || 4));

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
  if (!USE_LEADER_LOCK) return true;
  const pg = client?.pg;
  if (!pg?.query) return true;

  try {
    const r = await pg.query("SELECT pg_try_advisory_lock($1) AS ok", [LEADER_LOCK_KEY]);
    return Boolean(r.rows?.[0]?.ok);
  } catch (e) {
    console.warn("⚠️ [SweepEngine] leader lock check failed:", e?.message || e);
    return true;
  }
}

async function resolveProvider(chainName) {
  try {
    if (typeof getProvider === "function") {
      const p = getProvider(chainName);
      if (p) return p;
    }
  } catch (_) {}

  // Force providerM to pin one (best effort)
  try {
    const forced = await safeRpcCall(chainName, (p) => p, 2, 6000);
    if (forced) return forced;
  } catch {}

  if (!FALLBACK_RPC) {
    throw new Error("No provider available for sweep engine (no providerM + no fallback RPC)");
  }

  return new ethers.JsonRpcProvider(FALLBACK_RPC);
}

function isValidBigIntish(x) {
  return typeof x === "bigint" || (x && typeof x === "object" && typeof x.toString === "function");
}

/* ======================================================
   CORE: FETCH BALANCE (SAFE)
====================================================== */
async function fetchEngineBalance(chainName) {
  // ✅ Use safeRpcCall correctly: safeRpcCall(chain, (provider)=>...)
  const balRaw = await safeRpcCall(
    chainName,
    async (p) => {
      const token = new ethers.Contract(ADRIAN_TOKEN_CA, ERC20_ABI, p);
      return await token.balanceOf(ENGINE_CA);
    },
    CALL_RETRIES,
    CALL_TIMEOUT_MS
  );

  if (!balRaw) return null;
  return balRaw;
}

/* ======================================================
   INITIALIZE SNAPSHOT (ON BOOT)
====================================================== */
async function initSweepPower(client, chainName, decimals) {
  const balRaw = await fetchEngineBalance(chainName);
  if (!balRaw) {
    console.warn("🧹 Sweep engine init: balance fetch returned null (will retry on next poll)");
    return;
  }

  const bal = Number(ethers.formatUnits(balRaw, decimals));
  if (!Number.isFinite(bal)) {
    console.warn("🧹 Sweep engine init: formatted balance not finite");
    return;
  }

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
async function pollSweepPower(client, chainName, decimals) {
  const balRaw = await fetchEngineBalance(chainName);
  if (!balRaw || !isValidBigIntish(balRaw)) {
    throw new Error("balanceOf returned null/invalid (RPC unstable or rate limited)");
  }

  const bal = Number(ethers.formatUnits(balRaw, decimals));
  if (!Number.isFinite(bal)) {
    throw new Error("formatted balance is not finite");
  }

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
    console.log("🧹 ADRIAN Sweep Power Engine: disabled by ENABLE_ADRIAN_SWEEP_ENGINE=0");
    return;
  }

  const chainName = normalizeChain(RAW_CHAIN);

  const leaderOk = await tryAcquireLeaderLock(client);
  if (!leaderOk) {
    console.log("🧹 ADRIAN Sweep Power Engine: another instance holds leader lock — this instance will not poll.");
    return;
  }

  console.log("🧹 Starting ADRIAN Sweep Power Engine (BALANCE MODE)");

  try {
    await resolveProvider(chainName);
  } catch (e) {
    console.warn("🧹 Sweep engine: provider resolve failed:", e?.message || e);
    return;
  }

  // Fetch decimals/symbol safely (don’t spam; retries small)
  const decimals =
    (await safeRpcCall(
      chainName,
      async (p) => {
        const token = new ethers.Contract(ADRIAN_TOKEN_CA, ERC20_ABI, p);
        return Number(await token.decimals());
      },
      2,
      8000
    ).catch(() => 18)) || 18;

  const symbol =
    (await safeRpcCall(
      chainName,
      async (p) => {
        const token = new ethers.Contract(ADRIAN_TOKEN_CA, ERC20_ABI, p);
        return String(await token.symbol());
      },
      2,
      8000
    ).catch(() => "TOKEN")) || "TOKEN";

  console.log(`🧹 Token loaded → ${symbol} | Decimals: ${decimals} | chain=${chainName}`);

  // Always initialize from chain (best effort)
  try {
    await initSweepPower(client, chainName, decimals);
  } catch (e) {
    console.warn("🧹 Sweep engine init failed:", e?.message || e);
  }

  let backoffMs = 0;

  const loop = async () => {
    if (_stopped) return;
    if (_looping) return;
    _looping = true;

    try {
      await pollSweepPower(client, chainName, decimals);
      backoffMs = 0;
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn("🧹 Sweep poll error:", msg);

      backoffMs = Math.min(120000, Math.max(5000, (backoffMs || 0) * 2 || 5000));
    } finally {
      _looping = false;
      const next = withJitter(POLL_MS + backoffMs);
      _timer = setTimeout(loop, next);
    }
  };

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

