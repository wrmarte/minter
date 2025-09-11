// services/providerMatrix.js
const { JsonRpcProvider } = require('ethers');
const fetch = require('node-fetch');

/* =========================================================
   Matrix-dedicated provider manager (isolation from providerM)
   - Conservative batching caps (Base=10, Ape=3) to avoid coalesce errors
   - Windowed getLogs helper (≤ 9,500 blocks) for Base's 10k limit
   - Stricter error classification; rotate only on true network errors
   - Never throws from public APIs; returns null on failure
========================================================= */

/* ---------- Static baselines ---------- */
const STATIC_RPCS = {
  eth: [
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://rpc.ankr.com/eth'
  ],
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com',
    'https://base-rpc.publicnode.com',
    'https://base.gateway.tenderly.co'
  ],
  ape: [
    'https://rpc1.apexchain.xyz',
    'https://rpc.apexnetwork.xyz',
    'https://api.ape-rpc.com',
    'https://apex.rpc.thirdweb.com',
    'https://apexchain.alt.technology',
    'https://apex-mainnet.rpc.karzay.com',
    'https://apechain-rpc.publicnode.com'
  ]
};

/* ---------- Chain metadata ---------- */
const CHAIN_META = {
  eth:  { chainId: 1,    network: { name: 'homestead', chainId: 1 } },
  base: { chainId: 8453, network: { name: 'base', chainId: 8453 } },
  ape:  { chainId: 33139, network: { name: 'apechain', chainId: 33139 } }
};

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/* ---------- Internal state ---------- */
const RPCS = {
  eth: [...STATIC_RPCS.eth],
  base: [...STATIC_RPCS.base],
  ape: [...STATIC_RPCS.ape]
};

const chains = {}; // key -> { endpoints[], pinnedIdx, chainCooldownUntil, lastOfflineLogAt }
const selectLocks = new Map();
function now() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms) { return Math.floor(ms * (0.85 + Math.random() * 0.3)); }
function isThenable(x) { return x && typeof x.then === 'function'; }

/* ---------- Helpers ---------- */
function normalizeUrl(u) {
  if (!u || typeof u !== 'string') return u;
  u = u.trim();
  try {
    const url = new URL(u);
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
      if (url.pathname === '') url.pathname = '/';
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return u.replace(/\/+$/, '');
  }
}
function uniqueHttps(list) {
  const out = [];
  const seen = new Set();
  for (let url of list) {
    if (!url || typeof url !== 'string') continue;
    url = normalizeUrl(url);
    if (!url.startsWith('https://')) continue;
    if (/\$\{[^}]+\}/.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
function withTimeout(resultOrPromise, ms, reason = 'timeout') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(reason)); }
    }, ms);
    const ok = v => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
    const err = e => { if (!settled) { settled = true; clearTimeout(t); reject(e); } };
    try {
      if (isThenable(resultOrPromise)) resultOrPromise.then(ok, err);
      else ok(resultOrPromise);
    } catch (e) { err(e); }
  });
}

/* ---------- Error classification ---------- */
function isNetworkishError(err) {
  const code = String(err?.code || err?.error?.code || '').toUpperCase();
  const msg = String(err?.message || err?.shortMessage || '').toLowerCase();
  const body = String(err?.info?.responseBody || '').toLowerCase();
  return (
    code === 'NETWORK_ERROR' ||
    msg.includes('timeout') ||
    msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429') ||
    msg.includes('503') || msg.includes('502') || msg.includes('504') ||
    msg.includes('gateway') || msg.includes('temporarily') ||
    msg.includes('socket') || msg.includes('hang up') ||
    msg.includes('econnreset') || msg.includes('enotfound') ||
    msg.includes('fetch failed') || msg.includes('failed to fetch') ||
    body.includes('no backend is currently healthy') ||
    body.includes('service unavailable')
  );
}
function isBatchLimitError(err) {
  const msg = (err?.message || err?.shortMessage || '').toLowerCase();
  const body = (err?.info?.responseBody || '').toLowerCase();
  return msg.includes('maximum 10 calls in 1 batch') ||
         body.includes('maximum 10 calls in 1 batch') ||
         (String(err?.code || '').toUpperCase() === 'BAD_DATA' && (body.includes('maximum') || msg.includes('maximum')));
}
function isLogRangeError(err) {
  const body = (err?.info?.responseBody || '').toLowerCase();
  const msg  = (err?.message || '').toLowerCase();
  return body.includes('eth_getlogs is limited to a 10,000 range') ||
         msg.includes('eth_getlogs is limited to a 10,000 range') ||
         (String(err?.error?.code || err?.code || '') === '-32614');
}

/* ---------- Batch caps ---------- */
function getBatchConfig(key) {
  switch ((key || 'base').toLowerCase()) {
    case 'ape':  return { batchMaxCount: 3,  batchStallTime: 8 };
    case 'base': return { batchMaxCount: 10, batchStallTime: 8 };
    case 'eth':  return { batchMaxCount: 25, batchStallTime: 8 };
    default:     return { batchMaxCount: 10, batchStallTime: 8 };
  }
}

/* ---------- Init & rebuild ---------- */
function initChain(key) {
  if (chains[key]) return;
  chains[key] = {
    endpoints: (RPCS[key] || []).map(url => ({
      url,
      provider: null,
      failCount: 0,
      cooldownUntil: 0,
      lastOkAt: 0
    })),
    pinnedIdx: null,
    chainCooldownUntil: 0,
    lastOfflineLogAt: 0
  };
}
function rebuildChainEndpoints(key) {
  const st = chains[key];
  if (!st) return;
  const merged = uniqueHttps(RPCS[key] || []);
  st.endpoints = merged.map(url => ({
    url,
    provider: null,
    failCount: 0,
    cooldownUntil: 0,
    lastOkAt: 0
  }));
  st.pinnedIdx = null; // force reselection
}

/* ---------- Provider & scoring ---------- */
function makeProvider(key, url) {
  const meta = CHAIN_META[key] || {};
  const u = normalizeUrl(url);
  const batch = getBatchConfig(key);

  const p = new JsonRpcProvider(
    u,
    meta.network,
    {
      staticNetwork: !!meta.network,
      batchMaxCount: batch.batchMaxCount,
      batchStallTime: batch.batchStallTime
    }
  );
  p._rpcUrl = u;
  p.pollingInterval = 8000;
  return p;
}

async function pingProvider(provider, timeoutMs = 2500) {
  try {
    const res = await withTimeout(provider.getBlockNumber(), timeoutMs, 'rpc ping timeout');
    return Number.isInteger(res) && res >= 0;
  } catch {
    return false;
  }
}
function scoreEndpoint(ep) {
  const cd = Math.max(0, ep.cooldownUntil - now());
  const penalty = ep.failCount * 1000;
  const recency = ep.lastOkAt ? Math.max(0, now() - ep.lastOkAt) / 1000 : 9999;
  return cd + penalty + recency; // lower is better
}

/* ---------- Selection ---------- */
async function selectHealthy(key) {
  initChain(key);
  if (selectLocks.get(key)) return selectLocks.get(key);

  const run = (async () => {
    const st = chains[key];
    if (now() < st.chainCooldownUntil) return null;

    if (st.pinnedIdx != null) {
      const ep = st.endpoints[st.pinnedIdx];
      if (ep && now() >= ep.cooldownUntil) {
        if (!ep.provider) ep.provider = makeProvider(key, ep.url);
        return ep.provider;
      }
    }

    const ordered = st.endpoints
      .map((ep, idx) => ({ ep, idx, score: scoreEndpoint(ep) }))
      .sort((a, b) => a.score - b.score);

    for (const { ep, idx } of ordered) {
      if (now() < ep.cooldownUntil) continue;
      if (!ep.provider) ep.provider = makeProvider(key, ep.url);
      const ok = await pingProvider(ep.provider, 2000);
      if (ok) {
        ep.failCount = 0; ep.cooldownUntil = 0; ep.lastOkAt = now();
        chains[key].pinnedIdx = idx;
        console.log(`✅ matrix:${key} pinned RPC: ${ep.url}`);
        return ep.provider;
      } else {
        ep.failCount += 1;
        const backoff = Math.min(30000, 1000 ** Math.min(3, ep.failCount)) * 2;
        ep.cooldownUntil = now() + jitter(backoff);
      }
    }

    chains[key].pinnedIdx = null;
    chains[key].chainCooldownUntil = now() + 20000; // 20s
    if (now() - chains[key].lastOfflineLogAt > 60000) {
      console.warn(`⛔ matrix:${key} RPC offline. Cooling 20s.`);
      chains[key].lastOfflineLogAt = now();
    }
    return null;
  })();

  selectLocks.set(key, run);
  try { return await run; }
  finally { selectLocks.delete(key); }
}

/* ---------- Public API ---------- */
function getProvider(chain = 'base') {
  const key = (chain || 'base').toLowerCase();
  initChain(key);
  const st = chains[key];
  if (now() < st.chainCooldownUntil) return null;
  if (st.pinnedIdx == null) return null;
  const ep = st.endpoints[st.pinnedIdx];
  if (!ep || now() < ep.cooldownUntil) return null;
  if (!ep.provider) ep.provider = makeProvider(key, ep.url);
  return ep.provider;
}

async function rotateProvider(chain = 'base') {
  const key = chain.toLowerCase();
  initChain(key);
  const st = chains[key];

  if (st.pinnedIdx != null) {
    const ep = st.endpoints[st.pinnedIdx];
    if (ep) {
      ep.failCount += 1;
      const backoff = Math.min(30000, 1000 ** Math.min(3, ep.failCount)) * 2;
      ep.cooldownUntil = now() + jitter(backoff);
      console.warn(`🔁 matrix rotated RPC for ${key}: ${ep.url} cool ~${Math.round(backoff/1000)}s`);
    }
  }
  st.pinnedIdx = null;
  await selectHealthy(key);
}

async function safeRpcCall(chain, callFn, retries = 4, perCallTimeoutMs = 7000) {
  const key = (chain || 'base').toLowerCase();
  initChain(key);

  for (let i = 0; i < retries; i++) {
    let provider = getProvider(key);
    if (!provider) {
      provider = await selectHealthy(key);
      if (!provider) { await sleep(jitter(250 + i * 150)); continue; }
    }

    try {
      const result = await withTimeout(callFn(provider), perCallTimeoutMs, 'rpc call timeout');

      // success
      const st = chains[key];
      const ep = st.endpoints[st.pinnedIdx ?? -1];
      if (ep) { ep.failCount = 0; ep.cooldownUntil = 0; ep.lastOkAt = now(); }
      st.chainCooldownUntil = 0;

      return result;
    } catch (err) {
      const st = chains[key];
      const current = getProvider(key);
      const failUrl = current?._rpcUrl ||
                      (st.endpoints[st.pinnedIdx ?? -1] && st.endpoints[st.pinnedIdx ?? -1].url) ||
                      'unknown';

      if (isBatchLimitError(err)) {
        // do not rotate on batch-limit; tiny jitter then retry
        await sleep(jitter(6));
        continue;
      }
      if (isLogRangeError(err)) {
        // let callers handle by chunking ranges; return null
        return null;
      }
      if (isNetworkishError(err) || String(err?.message || '').toLowerCase().includes('timeout')) {
        console.warn(`⚠️ [matrix:${key}] network issue: ${err.message || err.code}`);
        console.warn(`🔻 RPC failed [${key}]: ${failUrl}`);
        await rotateProvider(key);
        await sleep(jitter(250 + i * 150));
        continue;
      }
      console.warn(`⚠️ [matrix:${key}] non-network RPC error: ${err.message || err.code}`);
      return null;
    }
  }
  console.error(`❌ matrix: all retries failed for ${chain}.`);
  return null;
}

function getMaxBatchSize(chain = 'base') {
  return (chain || 'base').toLowerCase() === 'ape' ? 3 : 10;
}

/* ---------- Windowed getLogs (Base-safe) ---------- */
const BASE_LOG_WINDOW_SAFE = Math.max(1000, Math.min(Number(process.env.MATRIX_BASE_LOG_WINDOW || 9500), 9500));
const BASE_LOG_CONCURRENCY = Math.max(1, Number(process.env.MATRIX_BASE_LOG_CONCURRENCY || 1));

async function getLogsWindowed(chain, baseParams, fromBlock, toBlock, {
  maxSpan = BASE_LOG_WINDOW_SAFE,
  concurrency = BASE_LOG_CONCURRENCY
} = {}) {
  const spans = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(toBlock, start + maxSpan - 1);
    spans.push({ fromBlock: start, toBlock: end });
    start = end + 1;
  }

  const out = [];
  let i = 0;
  async function worker() {
    while (i < spans.length) {
      const idx = i++;
      const { fromBlock: fb, toBlock: tb } = spans[idx];
      try {
        const logs = await safeRpcCall(
          chain,
          p => p.getLogs({ ...baseParams, fromBlock: fb, toBlock: tb }),
          3, 12000
        );
        if (Array.isArray(logs)) out.push(...logs);
      } catch {}
      await sleep(25 + Math.floor(Math.random() * 30));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, spans.length) }, worker);
  await Promise.all(workers);
  return out;
}

/* ---------- Dynamic discovery (light) ---------- */
async function fetchJson(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
function extractRpcUrlsFromChainRecord(rec) {
  const out = [];
  if (Array.isArray(rec.rpc)) out.push(...rec.rpc);
  if (Array.isArray(rec.rpcs)) out.push(...rec.rpcs);
  if (rec.rpcUrls && typeof rec.rpcUrls === 'object') {
    for (const k of Object.keys(rec.rpcUrls)) {
      const v = rec.rpcUrls[k];
      if (Array.isArray(v)) out.push(...v);
      else if (typeof v === 'string') out.push(v);
      else if (v && typeof v.url === 'string') out.push(v.url);
    }
  }
  return out;
}
async function discoverChainRpcs(chainId) {
  const collected = [];
  try {
    const list = await fetchJson('https://chainid.network/chains.json', 9000);
    if (Array.isArray(list)) {
      const rec = list.find(c => c.chainId === chainId);
      if (rec) collected.push(...extractRpcUrlsFromChainRecord(rec));
    }
  } catch {}
  return uniqueHttps(collected);
}
async function refreshRpcPool(key, reason = 'periodic') {
  const meta = CHAIN_META[key];
  if (!meta?.chainId) return;

  try {
    const fresh = await discoverChainRpcs(meta.chainId);
    if (!fresh.length) return;

    const merged = uniqueHttps([
      ...fresh,
      ...(STATIC_RPCS[key] || []),
      ...(RPCS[key] || [])
    ]);

    const before = (RPCS[key] || []).join(',');
    RPCS[key] = merged;

    if (before !== RPCS[key].join(',')) {
      console.log(`🔄 matrix:${key} RPC list updated (${reason}). Count=${RPCS[key].length}`);
      rebuildChainEndpoints(key);
      selectHealthy(key).catch(() => {});
    }
  } catch (e) {
    console.warn(`⚠️ matrix:${key} RPC discovery failed (${reason}): ${e.message}`);
  }
}

/* ---------- Bootstrap ---------- */
(async () => {
  await Promise.all([
    refreshRpcPool('eth', 'startup'),
    refreshRpcPool('base', 'startup'),
    refreshRpcPool('ape', 'startup')
  ]);

  for (const key of Object.keys(CHAIN_META)) {
    initChain(key);
    if (!chains[key].endpoints.length) {
      RPCS[key] = uniqueHttps([...(STATIC_RPCS[key] || [])]);
      rebuildChainEndpoints(key);
    }
    selectHealthy(key).catch(() => {});
  }

  setInterval(() => {
    for (const key of Object.keys(CHAIN_META)) {
      refreshRpcPool(key, 'periodic');
    }
  }, REFRESH_INTERVAL_MS);
})();

/* ---------- Exports ---------- */
module.exports = {
  getProvider,
  rotateProvider,
  safeRpcCall,
  getMaxBatchSize,
  getLogsWindowed
};
