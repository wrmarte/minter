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
const ENABLED = String(process.env.ENABLE_ADRIAN_SWEEP_ENGINE ?? "1").trim() === "1";
const RAW_CHAIN = process.env.SWEEP_ENGINE_CHAIN ?? "base";

const POLL_MS_RAW = Number(process.env.SWEEP_ENGINE_POLL_MS || 30000);
const POLL_MS = Math.max(8000, Number.isFinite(POLL_MS_RAW) ? POLL_MS_RAW : 30000);

const JITTER_MS = Math.max(0, Number(process.env.SWEEP_ENGINE_JITTER_MS || 750));

const USE_LEADER_LOCK = String(process.env.SWEEP_ENGINE_USE_LEADER_LOCK ?? "1").trim() === "1";
const LEADER_LOCK_KEY = Number(process.env.SWEEP_ENGINE_LOCK_KEY || 917301);

const DEBUG = String(process.env.SWEEP_ENGINE_DEBUG || "").trim() === "1";

// fallback RPC if providerM is unavailable
const FALLBACK_RPC = (process.env.SWEEP_ENGINE_BASE_RPC_URL || "").trim() || null;

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

/**
 * Ensure providerM has a pinned provider for this chain.
 * We do this by doing a tiny safeRpcCall. (safeRpcCall returns null on failure.)
 */
async function ensurePinnedProvider(chainName) {
  const p0 = (() => {
    try { return getProvider(chainName); } catch { return null; }
  })();
  if (p0) return true;

  const ok = await safeRpcCall(chainName, (p) => p.getBlockNumber(), 2, 5000);
  if (ok == null) return false;

  const p1 = (() => {
    try { return getProvider(chainName); } catch { return null; }
  })();
  return Boolean(p1);
}

async function resolveProvider(chainName) {
  // Try providerM
  try {
    const ok = await ensurePinnedProvider(chainName);
    if (ok) {
      const p = getProvider(chainName);
      if (p) return p;
    }
  } catch (_) {}

  // Fallback
  if (!FALLBACK_RPC) {
    throw new Error("No provider available for sweep engine (no providerM pinned + no fallback RPC)");
  }
  return new ethers.JsonRpcProvider(FALLBACK_RPC);
}

function safeNum(n, d = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}

/* ======================================================
   CORE RPC READERS (IMPORTANT FIXES)
   - safeRpcCall MUST be called as: safeRpcCall(chain, (provider)=>..., retries, timeout)
   - Never formatUnits(null)
====================================================== */
async function readDecimals(chainName) {
  const dec = await safeRpcCall(
    chainName,
    (p) => new ethers.Contract(ADRIAN_TOKEN_CA, ERC20_ABI, p).decimals(),
    3,
    8000
  );
  return dec == null ? 18 : Number(dec);
}

async function readSymbol(chainName) {
  const sym = await safeRpcCall(
    chainName,
    (p) => new ethers.Contract(ADRIAN_TOKEN_CA, ERC20_ABI, p).symbol(),
    3,
    8000
  );
  return (sym && String(sym).trim()) ? String(sym).trim() : "TOKEN";
}

async function readEngineBalanceRaw(chainName) {
  // returns BigInt or null
  const bal = await safeRpcCall(
    chainName,
    (p) => new ethers.Contract(ADRIAN_TOKEN_CA, ERC20_ABI, p).balanceOf(ENGINE_CA),
    4,
    9000
  );
  return bal == null ? null : bal;
}

/* ======================================================
   INITIALIZE SNAPSHOT (ON BOOT)
====================================================== */
async function initSweepPower(client, chainName, decimals) {
  const balRaw = await readEngineBalanceRaw(chainName);

  if (balRaw == null) {
    console.warn("🧹 Sweep engine init: balance read returned null (RPC issue). Snapshot set to 0.");
    client.sweepPowerSnapshot = {
      balanceRaw: 0n,
      balance: 0,
      lastBalance: null,
      delta: 0,
      updatedAt: new Date(),
      ok: false,
    };
    return false;
  }

  const bal = safeNum(ethers.formatUnits(balRaw, decimals), 0);

  client.sweepPowerSnapshot = {
    balanceRaw: balRaw,
    balance: bal,
    lastBalance: null,
    delta: 0,
    updatedAt: new Date(),
    ok: true,
  };

  console.log(`🧹 Sweep Power initialized → ${bal.toLocaleString()} ADRIAN`);
  return true;
}

/* ======================================================
   POLL LOOP (NO OVERLAP)
====================================================== */
async function pollSweepPower(client, chainName, decimals) {
  const balRaw = await readEngineBalanceRaw(chainName);

  if (balRaw == null) {
    throw new Error("balanceOf returned null (RPC failed / rotated)");
  }

  const bal = safeNum(ethers.formatUnits(balRaw, decimals), 0);

  const prev = client.sweepPowerSnapshot;
  const lastBalance = prev && typeof prev.balance === "number" ? prev.balance : null;
  const delta = lastBalance !== null ? bal - lastBalance : 0;

  client.sweepPowerSnapshot = {
    balanceRaw: balRaw,
    balance: bal,
    lastBalance,
    delta,
    updatedAt: new Date(),
    ok: true,
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

  // Try resolve provider once so we can fail early if totally dead
  try {
    await resolveProvider(chainName);
  } catch (e) {
    console.warn("🧹 Sweep engine: provider resolve failed:", e?.message || e);
    return;
  }

  // Cache decimals/symbol once
  const decimals = await readDecimals(chainName);
  const symbol = await readSymbol(chainName);
  console.log(`🧹 Token loaded → ${symbol} | Decimals: ${decimals} | chain=${chainName}`);

  // Initialize snapshot from chain
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

      // backoff (cap 2 min)
      backoffMs = Math.min(120000, Math.max(5000, (backoffMs || 0) * 2 || 5000));
      // mark snapshot unhealthy (but keep last values)
      if (client?.sweepPowerSnapshot) client.sweepPowerSnapshot.ok = false;
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

