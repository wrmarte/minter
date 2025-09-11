// services/providerMatrix.js
// Resilient multi-RPC provider pool with per-chain rotation, cooldowns, safe calls, and windowed getLogs.
// Namespaced logs for "matrix" so you see lines like: ✅ matrix:base pinned RPC: ...
const { JsonRpcProvider } = require('ethers');

const NS = 'matrix';

/* ---------- Static RPC pools ---------- */
const STATIC_RPCS = {
  eth: [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://rpc.ankr.com/eth'
  ],
  base: [
    'https://mainnet.base.org',
    'https://developer-access-mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com'
  ],
  ape: [
    // Add/confirm ApeChain RPCs here if used:
    'https://rpc.apechain.com',
    'https://apechain.caldera.dev',
  ]
};

/* ---------- State ---------- */
const pools = new Map();       // chain -> { urls, idx, lastFail: Map<url,ts>, cooldownMs, pinned?: url }
const providers = new Map();   // chain -> JsonRpcProvider

const DEFAULT_TIMEOUT_MS = 10_000;
const PER_ENDPOINT_COOLDOWN_MS = 6_000;
const PER_CHAIN_COOLDOWN_MS = 1_000;

/* ---------- Helpers ---------- */
function now() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensurePool(chain) {
  if (!pools.has(chain)) {
    const base = (STATIC_RPCS[chain] || []).slice();
    pools.set(chain, {
      urls: base,
      idx: 0,
      lastFail: new Map(),
      cooldownMs: PER_CHAIN_COOLDOWN_MS,
      pinned: null
    });
  }
  return pools.get(chain);
}

function logInfo(chain, msg) {
  console.log(`✅ ${NS}:${chain} ${msg}`);
}
function logWarn(chain, msg) {
  console.warn(`⚠️ [${NS}:${chain}] ${msg}`);
}
function logRotate(chain, url, cool='~2s') {
  console.log(`🔁 ${NS} rotated RPC for ${chain}: ${url} cool ${cool}`);
}
function logDown(chain, url) {
  console.log(`🔻 RPC failed [${chain}]: ${url}`);
}

/* ---------- Provider management ---------- */
function makeProvider(url) {
  return new JsonRpcProvider(url, undefined, { batchMaxCount: 1, staticNetwork: undefined, polling: false });
}
function setActiveProvider(chain, url) {
  const provider = makeProvider(url);
  providers.set(chain, provider);
  const pool = ensurePool(chain);
  pool.pinned = url;
  logInfo(chain, `pinned RPC: ${url}`);
  return provider;
}
function nextUrl(chain) {
  const pool = ensurePool(chain);
  const { urls, lastFail } = pool;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[(pool.idx + i) % urls.length];
    const lf = lastFail.get(url) || 0;
    if (now() - lf > PER_ENDPOINT_COOLDOWN_MS) {
      pool.idx = (pool.idx + i + 1) % urls.length;
      return url;
    }
  }
  pool.idx = (pool.idx + 1) % urls.length;
  return urls[pool.idx];
}
function markFail(chain, url) {
  const pool = ensurePool(chain);
  pool.lastFail.set(url, now());
  logDown(chain, url);
}

/* ---------- Public API ---------- */
function getProvider(chain) {
  ensurePool(chain);
  let provider = providers.get(chain);
  if (provider) return provider;
  const url = nextUrl(chain);
  return setActiveProvider(chain, url);
}

const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT','ECONNRESET','ENETUNREACH','EHOSTUNREACH','ECONNABORTED','SERVER_ERROR','TIMEOUT','NETWORK_ERROR'
]);

async function safeRpcCall(chain, fn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const provider = getProvider(chain);
  const url = pools.get(chain)?.pinned;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fn(provider);
    clearTimeout(t);
    return res;
  } catch (err) {
    clearTimeout(t);
    const code = err?.code || err?.error?.code || err?.name || '';
    const msg  = err?.message || '';

    if (controller.signal.aborted || /timeout/i.test(msg) || NETWORK_ERROR_CODES.has(code)) {
      logWarn(chain, 'network issue: rpc call timeout');
      markFail(chain, url);
      const url2 = nextUrl(chain);
      logRotate(chain, url2);
      await sleep(pools.get(chain).cooldownMs);
      setActiveProvider(chain, url2);
      try {
        const res2 = await fn(getProvider(chain));
        return res2;
      } catch (err2) {
        logWarn(chain, `non-network RPC error: ${err2?.message || err2}`);
        return null;
      }
    } else {
      logWarn(chain, `non-network RPC error: ${msg || code || 'unknown'}`);
      return null;
    }
  }
}

async function getLogsWindowed(chain, params, fromBlock, toBlock, windowSize) {
  const isBase = chain === 'base';
  const size = windowSize || (isBase ? 9000 : 50000);
  const out = [];

  let start = Math.max(0, fromBlock);
  let end = toBlock;

  while (start <= end) {
    const chunkTo = Math.min(end, start + size);
    const tryOnce = async () => {
      const prov = getProvider(chain);
      try {
        const logs = await prov.getLogs({ ...params, fromBlock: start, toBlock: chunkTo });
        return logs || [];
      } catch (e) {
        const msg = e?.message || '';
        if (/timeout|429|rate|busy|503|no backend/i.test(msg)) {
          logWarn(chain, 'network issue: rpc call timeout');
          markFail(chain, pools.get(chain)?.pinned);
          const nxt = nextUrl(chain);
          logRotate(chain, nxt);
          await sleep(pools.get(chain).cooldownMs);
          setActiveProvider(chain, nxt);
          return null;
        } else {
          logWarn(chain, `non-network RPC error: ${msg}`);
          return null;
        }
      }
    };

    let logs = await tryOnce();
    if (logs === null) {
      logs = await tryOnce();
      if (logs === null) logs = [];
    }
    out.push(...logs);
    start = chunkTo + 1;
  }

  return out;
}

module.exports = {
  getProvider,
  safeRpcCall,
  getLogsWindowed,
};
