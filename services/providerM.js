const { JsonRpcProvider } = require('ethers');
const fetch = require('node-fetch');

/* =========================================================
   Dynamic Ape RPC discovery + resilient pool
   - Auto-fetch free endpoints at startup & every 6h
   - Exponential backoff per endpoint + chain cooldown
   - Supports sync & async safeRpcCall
========================================================= */

// ---------- Static base lists ----------
const STATIC_RPCS = {
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com',
  ],
  eth: [
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://rpc.ankr.com/eth',
  ],
  ape: [
    'https://rpc1.apexchain.xyz',
    'https://rpc.apexnetwork.xyz',
    'https://api.ape-rpc.com',
    'https://apex.rpc.thirdweb.com',
    'https://apexchain.alt.technology',
    'https://apex-mainnet.rpc.karzay.com',
  ],
};

// Known freebies to try appending for Ape
const EXTRA_APE_FREE = [
  'https://apechain-rpc.publicnode.com',
  'https://rpc.apechain.io',
  'https://apechain.drpc.org',
  'https://rpc.apechain.p2p.org',
];

// ---------- Mutable pool (will be kept up-to-date) ----------
const RPCS = {
  base: [...STATIC_RPCS.base],
  eth: [...STATIC_RPCS.eth],
  ape: [...STATIC_RPCS.ape],
};

// ---------- Internal state ----------
const chains = {}; // chain -> { endpoints[], pinnedIdx, chainCooldownUntil, lastOfflineLogAt }
function now() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms) { return Math.floor(ms * (0.85 + Math.random() * 0.3)); }
function isThenable(x) { return x && typeof x.then === 'function'; }

function initChain(chain) {
  if (chains[chain]) return;
  chains[chain] = {
    endpoints: (RPCS[chain] || []).map(url => ({
      url,
      provider: null,
      failCount: 0,
      cooldownUntil: 0,
      lastOkAt: 0,
    })),
    pinnedIdx: null,
    chainCooldownUntil: 0,
    lastOfflineLogAt: 0,
  };
}

// ---------- Utils ----------
function uniqueHttps(list) {
  const out = [];
  const seen = new Set();
  for (let url of list) {
    if (!url || typeof url !== 'string') continue;
    url = url.trim();
    if (!url.startsWith('https://')) continue;
    if (/\$\{[^}]+\}/.test(url)) continue; // skip placeholdered URLs
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function rebuildChainEndpoints(chain) {
  const st = chains[chain];
  if (!st) return;
  const merged = uniqueHttps(RPCS[chain] || []);
  st.endpoints = merged.map(url => ({
    url,
    provider: null,
    failCount: 0,
    cooldownUntil: 0,
    lastOkAt: 0,
  }));
  st.pinnedIdx = null; // force re-selection
}

// ---------- Network / provider handling ----------
function makeProvider(chain, url) {
  const network = chain === 'ape' ? { name: 'apechain', chainId: 33139 } : undefined;
  const p = new JsonRpcProvider(url, network);
  p._rpcUrl = url;
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

// Promise/thenable-safe timeout wrapper
function withTimeout(resultOrPromise, ms, reason = 'timeout') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(reason)); }
    }, ms);

    const settleOk = (val) => { if (!settled) { settled = true; clearTimeout(t); resolve(val); } };
    const settleErr = (err) => { if (!settled) { settled = true; clearTimeout(t); reject(err); } };

    try {
      if (isThenable(resultOrPromise)) {
        resultOrPromise.then(settleOk, settleErr);
      } else {
        settleOk(resultOrPromise);
      }
    } catch (e) {
      settleErr(e);
    }
  });
}

function scoreEndpoint(ep) {
  const cd = Math.max(0, ep.cooldownUntil - now());
  const penalty = ep.failCount * 1000;
  const recency = ep.lastOkAt ? Math.max(0, now() - ep.lastOkAt) / 1000 : 9999;
  return cd + penalty + recency;
}

async function selectHealthy(chain) {
  initChain(chain);
  const st = chains[chain];

  if (now() < st.chainCooldownUntil) return null;

  if (st.pinnedIdx != null) {
    const ep = st.endpoints[st.pinnedIdx];
    if (ep && now() >= ep.cooldownUntil) {
      if (!ep.provider) ep.provider = makeProvider(chain, ep.url);
      return ep.provider;
    }
  }

  const ordered = st.endpoints
    .map((ep, idx) => ({ ep, idx, score: scoreEndpoint(ep) }))
    .sort((a, b) => a.score - b.score);

  for (const { ep, idx } of ordered) {
    if (now() < ep.cooldownUntil) continue;
    if (!ep.provider) ep.provider = makeProvider(chain, ep.url);

    const ok = await pingProvider(ep.provider, 2000);
    if (ok) {
      ep.failCount = 0;
      ep.cooldownUntil = 0;
      ep.lastOkAt = now();
      st.pinnedIdx = idx;
      console.log(`✅ ${chain} initialized/pinned RPC: ${ep.url}`);
      return ep.provider;
    } else {
      ep.failCount += 1;
      const backoff = Math.min(30000, 1000 ** Math.min(3, ep.failCount)) * 2; // conservative backoff
      ep.cooldownUntil = now() + jitter(backoff);
    }
  }

  st.pinnedIdx = null;
  st.chainCooldownUntil = now() + 20000; // chain cooldown 20s
  if (now() - st.lastOfflineLogAt > 60000) {
    console.warn(`⛔ ${chain} RPC appears offline. Cooling down 20s.`);
    st.lastOfflineLogAt = now();
  }
  return null;
}

// ---------- Public API ----------
function getProvider(chain = 'base') {
  const key = (chain || 'base').toLowerCase();
  initChain(key);
  const st = chains[key];
  if (now() < st.chainCooldownUntil) {
    console.warn(`⚠️ No live provider for "${key}". Returning null (chain cooldown).`);
    return null;
  }
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
      console.warn(`🔁 Rotated RPC for ${key}: ${ep.url} cooling down ~${Math.round(backoff / 1000)}s`);
    }
  }
  st.pinnedIdx = null;
  await selectHealthy(key);
}

async function safeRpcCall(chain, callFn, retries = 4, perCallTimeoutMs = 6000) {
  const key = (chain || 'base').toLowerCase();
  initChain(key);

  for (let i = 0; i < retries; i++) {
    let provider = getProvider(key);
    if (!provider) {
      provider = await selectHealthy(key);
      if (!provider) { await sleep(jitter(300 + i * 200)); continue; }
    }

    try {
      const result = await withTimeout(callFn(provider), perCallTimeoutMs, 'rpc call timeout');
      const st = chains[key];
      const ep = st.endpoints[st.pinnedIdx ?? -1];
      if (ep) {
        ep.failCount = 0;
        ep.cooldownUntil = 0;
        ep.lastOkAt = now();
      }
      st.chainCooldownUntil = 0;
      return result;
    } catch (err) {
      const msg = err?.info?.responseBody || err?.message || '';
      const code = err?.code || 'UNKNOWN_ERROR';
      console.warn(`⚠️ [${key}] RPC Error: ${err.message || code}`);
      const current = getProvider(key);
      const st = chains[key];
      const failUrl =
        current?._rpcUrl ||
        (st.endpoints[st.pinnedIdx ?? -1] && st.endpoints[st.pinnedIdx ?? -1].url) ||
        'unknown';
      console.warn(`🔻 RPC failed [${key}]: ${failUrl}`);

      // Ape batch limit special-case
      const isApeBatchLimit = key === 'ape' && msg.includes('Batch of more than 3 requests');
      if (isApeBatchLimit) {
        console.warn('⛔ ApeChain batch limit hit — skip batch, no retry');
        return null;
      }

      await rotateProvider(key);
      await sleep(jitter(300 + i * 200));
    }
  }

  console.error(`❌ All retries failed for ${key}. Returning null.`);
  return null;
}

function getMaxBatchSize(chain = 'base') {
  return (chain || 'base').toLowerCase() === 'ape' ? 3 : 10;
}

// ---------- Dynamic Ape RPC discovery ----------
async function fetchJson(url, timeoutMs = 6000) {
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
  // Try common fields: rpc / rpcs / rpcUrls with arrays of strings
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

async function discoverApeRpcs() {
  const collected = [];

  // 1) chainid.network (canonical list)
  try {
    const chains = await fetchJson('https://chainid.network/chains.json', 8000);
    if (Array.isArray(chains)) {
      const ape = chains.find(c => c.chainId === 33139 || /ape/i.test(c.name || '') || /ape/i.test(c.chain || ''));
      if (ape) {
        collected.push(...extractRpcUrlsFromChainRecord(ape));
      }
    }
  } catch (e) {
    // ignore
  }

  // 2) Chainlist dev API fallback
  try {
    const data = await fetchJson('https://chainlist.org/chain/33139', 8000).catch(() => null);
    if (data) {
      const urls = extractRpcUrlsFromChainRecord(data);
      collected.push(...urls);
    }
  } catch (e) {
    // ignore
  }

  // 3) Merge in static suggestions
  collected.push(...STATIC_RPCS.ape, ...EXTRA_APE_FREE);

  return uniqueHttps(collected);
}

async function refreshApeRpcPool(reason = 'startup') {
  try {
    const fresh = await discoverApeRpcs();
    if (!fresh.length) return;

    // Merge with current pool, keep order preferring fresh first
    const merged = uniqueHttps([...fresh, ...RPCS.ape]);
    const before = RPCS.ape.join(',');
    RPCS.ape = merged;

    if (before !== RPCS.ape.join(',')) {
      console.log(`🔄 Ape RPC list updated (${reason}). Count=${RPCS.ape.length}`);
      rebuildChainEndpoints('ape');
      // Try to pin a healthy endpoint ASAP (non-blocking)
      selectHealthy('ape').catch(() => {});
    }
  } catch (e) {
    console.warn(`⚠️ Ape RPC discovery failed (${reason}): ${e.message}`);
  }
}

// ---------- Bootstrap ----------
(async () => {
  // Initial endpoint discovery for Ape
  await refreshApeRpcPool('startup');

  // Initialize other chains
  for (const chain of ['base', 'eth']) {
    initChain(chain);
    if (!chains[chain].endpoints.length) {
      RPCS[chain] = [...STATIC_RPCS[chain]];
      rebuildChainEndpoints(chain);
    }
    // try pin
    selectHealthy(chain).catch(() => {});
  }

  // Attempt to pin Ape too
  initChain('ape');
  selectHealthy('ape').catch(() => {});

  // Periodic Ape RPC refresh every 6 hours
  setInterval(() => {
    refreshApeRpcPool('periodic');
  }, 6 * 60 * 60 * 1000);
})();

module.exports = {
  getProvider,
  rotateProvider,
  safeRpcCall,
  getMaxBatchSize,
};






