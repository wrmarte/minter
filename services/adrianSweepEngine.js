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
// - No guild locking
// - Safe RPC via providerM (with fallback)
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
const CHAIN = process.env.SWEEP_ENGINE_CHAIN || "base";
const POLL_MS = Number(process.env.SWEEP_ENGINE_POLL_MS || 12000);
const DEBUG = String(process.env.SWEEP_ENGINE_DEBUG || "").trim() === "1";

// fallback RPC if providerM is unavailable
const FALLBACK_RPC =
  process.env.SWEEP_ENGINE_BASE_RPC_URL || null;

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
let _timer = null;

/* ======================================================
   HELPERS
====================================================== */
function log(...args) {
  if (DEBUG) console.log("🧹 [SweepEngine]", ...args);
}

async function resolveProvider() {
  try {
    if (typeof getProvider === "function") {
      const p = getProvider(CHAIN);
      if (p) return p;
    }
  } catch (_) {}

  if (!FALLBACK_RPC) {
    throw new Error("No provider available for sweep engine");
  }

  return new ethers.JsonRpcProvider(FALLBACK_RPC);
}

/* ======================================================
   CORE: FETCH BALANCE
====================================================== */
async function fetchEngineBalance(provider, token) {
  return safeRpcCall(async () => {
    const bal = await token.balanceOf(ENGINE_CA);
    return bal;
  });
}

/* ======================================================
   INITIALIZE SNAPSHOT (ON BOOT)
====================================================== */
async function initSweepPower(client, provider, token, decimals) {
  const balRaw = await fetchEngineBalance(provider, token);
  const bal = Number(ethers.formatUnits(balRaw, decimals));

  client.sweepPowerSnapshot = {
    balanceRaw: balRaw,
    balance: bal,
    lastBalance: null,
    delta: 0,
    updatedAt: new Date(),
  };

  console.log(
    `🧹 Sweep Power initialized → ${bal.toLocaleString()} ADRIAN`
  );
}

/* ======================================================
   POLL LOOP
====================================================== */
async function pollSweepPower(client, provider, token, decimals) {
  const balRaw = await fetchEngineBalance(provider, token);
  const bal = Number(ethers.formatUnits(balRaw, decimals));

  const prev = client.sweepPowerSnapshot;
  const lastBalance = prev ? prev.balance : null;
  const delta =
    lastBalance !== null ? bal - lastBalance : 0;

  client.sweepPowerSnapshot = {
    balanceRaw: balRaw,
    balance: bal,
    lastBalance,
    delta,
    updatedAt: new Date(),
  };

  log(
    "Balance updated:",
    bal,
    "Δ",
    delta >= 0 ? `+${delta}` : delta
  );
}

/* ======================================================
   PUBLIC STARTER
====================================================== */
async function startSweepEngine(client) {
  if (_running) return;
  _running = true;

  console.log("🧹 Starting ADRIAN Sweep Power Engine (BALANCE MODE)");

  const provider = await resolveProvider();
  const token = new ethers.Contract(
    ADRIAN_TOKEN_CA,
    ERC20_ABI,
    provider
  );

  const decimals = await safeRpcCall(() => token.decimals());
  const symbol = await safeRpcCall(() => token.symbol());

  console.log(
    `🧹 Token loaded → ${symbol} | Decimals: ${decimals}`
  );

  // 🔑 ALWAYS initialize snapshot from chain
  await initSweepPower(client, provider, token, decimals);

  _timer = setInterval(async () => {
    try {
      await pollSweepPower(client, provider, token, decimals);
    } catch (err) {
      console.error("🧹 Sweep poll error:", err.message);
    }
  }, POLL_MS);
}

/* ======================================================
   PUBLIC STOPPER (OPTIONAL)
====================================================== */
function stopSweepEngine() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _running = false;
}

module.exports = {
  startSweepEngine,
  stopSweepEngine,
};

