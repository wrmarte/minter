// services/providerMatrix.js
// Robust provider & log-window helper for Matrix.
// - Rotates RPCs on network faults, with cool-down logs
// - Per-call timeouts (deadlines) so callers never hang
// - Windowed getLogs with adaptive splitting & concurrency
// - Works for chains: eth, base, ape
//
// Exports:
//   - getProvider(chain)
//   - safeRpcCall(chain, fn, opts?)
//   - getLogsWindowed(chain, params, fromBlock, toBlock, opts?)
//
const { ethers } = require('ethers');

/* ===================== Config ===================== */
// Visible tag in logs so you can tell which module is talking
const TAG = process.env.MATRIX_TAG || 'matrix';

// Global call timeouts (ms)
const CALL_TIMEOUT_ETH   = Number(process.env.MATRIX_CALL_TIMEOUT_ETH   || 8000);
const CALL_TIMEOUT_BASE  = Number(process.env.MATRIX_CALL_TIMEOUT_BASE  || 10000);
const CALL_TIMEOUT_APE   = Number(process.env.MATRIX_CALL_TIMEOUT_APE   || 9000);

// getLogs window slicing (blocks per sub-window)
const LOG_SUBRANGE_ETH   = Number(process.env.MATRIX_LOG_SUBRANGE_ETH   || 12000);
const LOG_SUBRANGE_BASE  = Number(process.env.MATRIX_LOG_SUBRANGE_BASE  || 1200);
const LOG_SUBRANGE_APE   = Number(process.env.MATRIX_LOG_SUBRANGE_APE   || 3000);

// getLogs concurrency
const LOG_FETCH_CONC_ETH  = Number(process.env.MATRIX_LOG_FETCH_CONC_ETH  || 3);
const LOG_FETCH_CONC_BASE = Number(process.env.MATRIX_LOG_FETCH_CONC_BASE || 1);
const LOG_FETCH_CONC_APE  = Number(process.env.MATRIX_LOG_FETCH_CONC_APE  || 2);

// If a single subrange returns >= this many logs, we adaptively split further
const LOG_SPLIT_THRESHOLD = Number(process.env.MATRIX_LOG_SPLIT_THRESHOLD || 2000);

// Rotate retries per call (we’ll try up to this many distinct RPCs before giving up)
const ROTATE_RETRIES = Number(process.env.MATRIX_ROTATE_RETRIES || 6);

// Cooldown note (purely cosmetic log)
const ROTATE_COOLDOWN_NOTE = process.env.MATRIX_ROTATE_COOLDOWN_NOTE || 'cool ~2s';

// Helper
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* ===================== RPC Lists (from env + sane defaults) ===================== */
function parseList(envVal) {
  return (envVal || '')
    .split(/[,\s]+/g)
    .map(s => s.trim())
    .filter(Boolean);
}

function unique(list) {
  return Array.from(new Set(list));
}

const ETH_DEFAULTS = unique([
  ...parseList(process.env.ETH_RPC_LIST),
  'https://ethereum-rpc.publicnode.com',
  'https://cloudflare-eth.com',
  'https://rpc.ankr.com/eth',
  'https://eth.llamarpc.com',
  'https://1rpc.io/eth'
]);

const BASE_DEFAULTS = unique([
  ...parseList(process.env.BASE_RPC_LIST),
  'https://mainnet.base.org',
  'https://developer-access-mainnet.base.org',
  'https://base.publicnode.com',
  'https://1rpc.io/base',
  'https://base.drpc.org',
  'https://base.llamarpc.com'
]);

const APE_DEFAULTS = unique([
  ...parseList(process.env.APE_RPC_LIST),
  'https://rpc.apechain.com',
  'https://apechain.drpc.org'
]);

/* ===================== Chain Registry ===================== */
const CHAINS = {
  eth:  { key: 'eth',  rpcs: ETH_DEFAULTS,  callTimeout: CALL_TIMEOUT_ETH,  logSub: LOG_SUBRANGE_ETH,  conc: LOG_FETCH_CONC_ETH  },
  base: { key: 'base', rpcs: BASE_DEFAULTS, callTimeout: CALL_TIMEOUT_BASE, logSub: LOG_SUBRANGE_BASE, conc: LOG_FETCH_CONC_BASE },
  ape:  { key: 'ape',  rpcs: APE_DEFAULTS,  callTimeout: CALL_TIMEOUT_APE,  logSub: LOG_SUBRANGE_APE,  conc: LOG_FETCH_CONC_APE  },
};

// Per-chain state: pinned RPC index, provider cache, failure counters
const STATE = Object.fromEntries(Object.keys(CHAINS).map(k => [k, {
  pinnedIdx: -1,
  providerByUrl: new Map(),     // url -> ethers.JsonRpcProvider
  seenUrl: new Set(),
  failureScore: new Map(),      // url -> number
}]));

/* ===================== Logging helpers ===================== */
function logPin(chain, url, isInit=false) {
  const prefix = `${TAG}:${chain}`;
  if (isInit) {
    console.log(`✅ ${chain} initialized/pinned RPC: ${url}`);
  }
  console.log(`✅ ${prefix} pinned RPC: ${url}`);
}
function logRotate(chain, url) {
  console.warn(`🔁 ${TAG} rotated RPC for ${chain}: ${url} ${ROTATE_COOLDOWN_NOTE}`);
}
function logRpcFail(chain, url, msg) {
  console.warn(`🔻 RPC failed [${chain}]: ${url}${msg ? `\n${msg}` : ''}`);
}
function logNetIssue(chain, detail) {
  console.warn(`⚠️ [${TAG}:${chain}] network issue: ${detail}`);
}
function logNonNetIssue(chain, detail) {
  console.warn(`⚠️ [${TAG}:${chain}] non-network RPC error: ${detail}`);
}

/* ===================== Provider & Rotation ===================== */
function getChainInfo(chain) {
  const key = String(chain || '').toLowerCase();
  return CHAINS[key] ? CHAINS[key] : null;
}

function getState(chain) {
  return STATE[chain];
}

function ensurePinned(chain) {
  const info = getChainInfo(chain);
  if (!info) return null;
  const st = getState(chain);
  if (!info.rpcs.length) return null;

  if (st.pinnedIdx < 0) {
    st.pinnedIdx = 0;
    const url = info.rpcs[st.pinnedIdx];
    logPin(chain, url, true);
  }
  return info.rpcs[st.pinnedIdx];
}

function rotate(chain) {
  const info = getChainInfo(chain);
  if (!info) return null;
  const st = getState(chain);
  if (!info.rpcs.length) return null;

  const oldIdx = st.pinnedIdx >= 0 ? st.pinnedIdx : 0;
  const nextIdx = (oldIdx + 1) % info.rpcs.length;
  st.pinnedIdx = nextIdx;
  const url = info.rpcs[nextIdx];
  logRotate(chain, url);
  logPin(chain, url, false);
  return url;
}

function getOrCreateProvider(chain, url) {
  const st = getState(chain);
  if (!st) return null;
  if (st.providerByUrl.has(url)) return st.providerByUrl.get(url);
  // Use a light provider (no batch) for compatibility; ethers v6
  const prov = new ethers.JsonRpcProvider(url);
  st.providerByUrl.set(url, prov);
  return prov;
}

function getProvider(chain) {
  const pinned = ensurePinned(chain);
  if (!pinned) return null;
  return getOrCreateProvider(chain, pinned);
}

/* ===================== Error Classification ===================== */
function classifyRpcError(err) {
  const s = String(err && (err.message || err.code || err.name || err)).toLowerCase();
  // Network-ish signals
  if (s.includes('timeout') || s.includes('timed out')) return { network: true, code: 'TIMEOUT' };
  if (s.includes('network error') || s.includes('fetch') || s.includes('failed to fetch')) return { network: true, code: 'NETWORK' };
  if (s.includes('503') || s.includes('bad gateway') || s.includes('502') || s.includes('500')) return { network: true, code: 'SERVER' };
  if (s.includes('no backend is currently healthy')) return { network: true, code: 'SERVER' };
  if (s.includes('request aborted') || s.includes('aborted')) return { network: true, code: 'ABORT' };
  if (s.includes('socket hang up')) return { network: true, code: 'SOCKET' };
  // dRPC free-tier code / messages
  if (s.includes('request timeout on the free tier') || s.includes('"code":30')) return { network: true, code: 'TIER_LIMIT' };

  // EVM call exceptions (non-network)
  if (s.includes('call exception') || s.includes('execution reverted') || s.includes('missing revert data')) {
    return { network: false, code: 'CALL_EXCEPTION' };
  }
  // Default: assume non-network
  return { network: false, code: 'OTHER' };
}

/* ===================== Deadline helper ===================== */
function withDeadline(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) {
        try { onTimeout(); } catch {}
      }
      reject(new Error('rpc call timeout'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ===================== safeRpcCall ===================== */
async function safeRpcCall(chain, fn, opts = {}) {
  const info = getChainInfo(chain);
  if (!info) throw new Error(`Unsupported chain: ${chain}`);
  const timeoutMs = Number(opts.timeoutMs || info.callTimeout);
  let attempts = 0;
  let rotations = 0;

  while (attempts < Math.max(1, ROTATE_RETRIES)) {
    const url = ensurePinned(chain);
    const prov = getOrCreateProvider(chain, url);
    attempts++;

    try {
      const result = await withDeadline(
        Promise.resolve().then(() => fn(prov)),
        timeoutMs,
        () => { logNetIssue(chain, 'rpc call timeout'); }
      );
      return result;
    } catch (err) {
      const cls = classifyRpcError(err);
      if (cls.network) {
        logRpcFail(chain, url, `(${err && err.message ? err.message : String(err)})`);
        // rotate & retry
        rotate(chain);
        rotations++;
        continue;
      } else {
        // non-network error: surface it, do not rotate (usually contract revert / parse issues)
        logNonNetIssue(chain, `${err && err.message ? err.message : String(err)}`);
        throw err;
      }
    }
  }

  // Final fallback: last attempt on current pinned (no rotate log spam)
  const finalUrl = ensurePinned(chain);
  const finalProv = getOrCreateProvider(chain, finalUrl);
  try {
    const result = await withDeadline(
      Promise.resolve().then(() => fn(finalProv)),
      timeoutMs,
      () => { logNetIssue(chain, 'rpc call timeout'); }
    );
    return result;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    logRpcFail(chain, finalUrl, `(final) ${msg}`);
    throw err;
  }
}

/* ===================== getLogsWindowed ===================== */
/**
 * Window-safe log fetch:
 *  - Slices the [from,to] range into subranges per chain policy
 *  - Fetches with limited concurrency
 *  - If a subrange returns a *lot* of logs (>= threshold), recursively splits it
 *  - Dedups and returns logs sorted by (blockNumber, logIndex)
 *
 * @param {string} chain  'eth' | 'base' | 'ape'
 * @param {object} params getLogs filter { address?, topics? }
 * @param {number} fromBlock inclusive
 * @param {number} toBlock   inclusive
 * @param {object} opts { timeoutMs?, subrangeSize?, concurrency? }
 * @returns {Promise<Array>} logs
 */
async function getLogsWindowed(chain, params, fromBlock, toBlock, opts = {}) {
  const info = getChainInfo(chain);
  if (!info) throw new Error(`Unsupported chain: ${chain}`);

  const subrange = clamp(
    Number(opts.subrangeSize || info.logSub),
    100, // min
    200_000 // max safety
  );
  const conc = clamp(Number(opts.concurrency || info.conc), 1, 6);
  const timeoutMs = Number(opts.timeoutMs || info.callTimeout);

  const rangePairs = [];
  const a = Math.max(0, Number(fromBlock) | 0);
  const b = Math.max(a, Number(toBlock) | 0);
  for (let start = a; start <= b; start += subrange) {
    const end = Math.min(b, start + subrange - 1);
    rangePairs.push([start, end]);
  }

  // Small runner with limited concurrency
  const results = [];
  let idx = 0;

  const runOne = async () => {
    const myIdx = idx++;
    if (myIdx >= rangePairs.length) return;
    const [fa, fb] = rangePairs[myIdx];

    try {
      const logs = await fetchLogsAdaptive(chain, params, fa, fb, timeoutMs);
      results.push(logs);
    } catch (err) {
      // On error, we log and push empty to keep progress flowing
      const msg = err && err.message ? err.message : String(err);
      logNetIssue(chain, `getLogs failed ${fa}-${fb}: ${msg}`);
      results.push([]);
    }
    return runOne();
  };

  const runners = new Array(Math.min(conc, rangePairs.length)).fill(0).map(runOne);
  await Promise.all(runners);

  const flat = results.flat();
  // Dedup by txHash+logIndex, then sort
  const seen = new Set();
  const dedup = [];
  for (const l of flat) {
    const key = `${l.transactionHash || l.txHash || ''}:${l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(l);
  }
  dedup.sort((x, y) => {
    const bn = Number(x.blockNumber) - Number(y.blockNumber);
    return bn !== 0 ? bn : (Number(x.logIndex) - Number(y.logIndex));
  });

  return dedup;
}

// Recursively split a range if it returns too many logs
async function fetchLogsAdaptive(chain, params, fromBlock, toBlock, timeoutMs, depth = 0) {
  // Base case
  if (fromBlock > toBlock) return [];

  const attempt = async () => {
    const filter = { ...params, fromBlock, toBlock };
    return await safeRpcCall(chain, p => p.getLogs(filter), { timeoutMs });
  };

  let logs;
  try {
    logs = await attempt();
  } catch (err) {
    // Let safeRpcCall handle rotation. If it still throws, bubble up.
    throw err;
  }

  if (Array.isArray(logs) && logs.length >= LOG_SPLIT_THRESHOLD && (toBlock - fromBlock) > 20) {
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const left  = await fetchLogsAdaptive(chain, params, fromBlock, mid, timeoutMs, depth + 1);
    const right = await fetchLogsAdaptive(chain, params, mid + 1, toBlock, timeoutMs, depth + 1);
    return left.concat(right);
  }

  return Array.isArray(logs) ? logs : [];
}

/* ===================== Live list refresh helpers (optional) ===================== */
/**
 * Optionally refresh RPC list at runtime:
 *   setRpcList('base', ['https://...','https://...'])
 */
function setRpcList(chain, list) {
  const info = getChainInfo(chain);
  if (!info) throw new Error(`Unsupported chain: ${chain}`);
  if (!Array.isArray(list) || list.length === 0) throw new Error('RPC list must be a non-empty array');
  info.rpcs = unique(list);
  // Reset pin to first new URL
  const st = getState(chain);
  st.pinnedIdx = -1;
  ensurePinned(chain);
  console.log(`🔄 ${chain} RPC list updated (runtime). Count=${info.rpcs.length}`);
}

/* ===================== Exports ===================== */
module.exports = {
  getProvider,
  safeRpcCall,
  getLogsWindowed,
  setRpcList, // optional, for dynamic updates
};
