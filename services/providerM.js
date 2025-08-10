const { JsonRpcProvider } = require('ethers');

// ===================== RPC lists per chain =====================
const RPCS = {
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com'
  ],
  eth: [
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://rpc.ankr.com/eth'
  ],
  ape: [
    'https://rpc1.apexchain.xyz',
    'https://rpc.apexnetwork.xyz',
    'https://api.ape-rpc.com',
    'https://apex.rpc.thirdweb.com',
    'https://apexchain.alt.technology',
    'https://apex-mainnet.rpc.karzay.com'
  ]
};

// ===================== Internal state =====================
const chains = {}; // chain -> { endpoints[], pinnedIdx, chainCooldownUntil, lastOfflineLogAt }
function now() { return Date.now(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms) { return Math.floor(ms * (0.85 + Math.random() * 0.3)); }
function isThenable(x) { return x && typeof x.then === 'function'; }

// Promise/thenable-safe timeout wrapper (works with sync returns, too)
function withTimeout(resultOrPromise, ms, reason = 'timeout') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(reason));
      }
    }, ms);

    const settleOk = (val) => {
      if (!settled) {
        settled = true;
        clearTimeout(t);
        resolve(val);
      }
    };
    const settleErr = (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(t);
        reject(err);
      }
    };

    try {
      if (isThenable(resultOrPromise)) {
        resultOrPromise.then(settleOk, settleErr);
      } else {
        // Synchronous value — resolve immediately
        settleOk(resultOrPromise);
      }
    } catch (e) {
      settleErr(e);
    }
  });
}

function initChain(chain) {
  if (chains[chain]) return;
  chains[chain] = {
    endpoints: (RPCS[chain] || []).map(url => ({
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

// Build provider with optional ApeChain network hint
function makeProvider(chain, url) {
  const network = chain === 'ape' ? { name: 'apechain', chainId: 33139 } : undefined;
  const p = new JsonRpcProvider(url, network);
  p._rpcUrl = url;
  p.pollingInterval = 8000;
  return p;
}

// Quick JSON-RPC liveness probe
async function pingProvider(provider, timeoutMs = 2500) {
  try {
    const res = await withTimeout(provider.getBlockNumber(), timeoutMs, 'rpc ping timeout');
    return Number.isInteger(res) && res >= 0;
  } catch {
    return false;
  }
}

// Score endpoints: lower is better
function scoreEndpoint(ep) {
  const cd = Math.max(0, ep.cooldownUntil - now()); // ms
  const penalty = ep.failCount * 1000;
  const recency = ep.lastOkAt ? Math.max(0, now() - ep.lastOkAt) / 1000 : 9999;
  return cd + penalty + recency;
}

// Attempt to select and pin a healthy provider
async function selectHealthy(chain) {
  initChain(chain);
  const st = chains[chain];

  if (now() < st.chainCooldownUntil) return null;

  // If current pin exists & not cooling, reuse
  if (st.pinnedIdx != null) {
    const ep = st.endpoints[st.pinnedIdx];
    if (ep && now() >= ep.cooldownUntil) {
      if (!ep.provider) ep.provider = makeProvider(chain, ep.url);
      return ep.provider;
    }
  }

  // Sort endpoints by health score
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
      // backoff this endpoint
      ep.failCount += 1;
      const backoff = Math.min(30000, 1000 * Math.pow(2, ep.failCount)); // cap 30s
      ep.cooldownUntil = now() + jitter(backoff);
    }
  }

  // All endpoints failed -> put chain in cooldown
  st.pinnedIdx = null;
  st.chainCooldownUntil = now() + 20000; // 20s
  if (now() - st.lastOfflineLogAt > 60000) {
    console.warn(`⛔ ${chain} RPC appears offline. Cooling down 20s.`);
    st.lastOfflineLogAt = now();
  }
  return null;
}

// ===================== Public API =====================

// Get current provider (may return null during chain cooldown)
function getProvider(chain = 'base') {
  const key = (chain || 'base').toLowerCase();
  initChain(key);

  const st = chains[key];
  if (now() < st.chainCooldownUntil) {
    console.warn(`⚠️ No live provider for "${key}". Returning null (chain cooldown).`);
    return null;
  }

  const idx = st.pinnedIdx;
  if (idx == null) {
    // Not pinned yet; caller should use safeRpcCall to trigger selection
    return null;
  }
  const ep = st.endpoints[idx];
  if (!ep || now() < ep.cooldownUntil) return null;
  if (!ep.provider) ep.provider = makeProvider(key, ep.url);
  return ep.provider;
}

// Rotate to next provider: unpin and trigger reselection on next call
async function rotateProvider(chain = 'base') {
  const key = chain.toLowerCase();
  initChain(key);
  const st = chains[key];

  if (st.pinnedIdx != null) {
    const ep = st.endpoints[st.pinnedIdx];
    if (ep) {
      ep.failCount += 1;
      const backoff = Math.min(30000, 1000 * Math.pow(2, ep.failCount));
      ep.cooldownUntil = now() + jitter(backoff);
      console.warn(`🔁 Rotated RPC for ${key}: ${ep.url} cooling down ~${Math.round(backoff / 1000)}s`);
    }
  }
  st.pinnedIdx = null;
  // Attempt immediate reselection (non-blocking for callers)
  await selectHealthy(key);
}

// Failover-safe RPC call with retries + timeout
async function safeRpcCall(chain, callFn, retries = 4, perCallTimeoutMs = 6000) {
  const key = (chain || 'base').toLowerCase();
  initChain(key);

  let lastErr = null;

  for (let i = 0; i < retries; i++) {
    let provider = getProvider(key);
    if (!provider) {
      provider = await selectHealthy(key);
      if (!provider) {
        // Chain in cooldown or all endpoints down
        await sleep(jitter(300 + i * 200));
        continue;
      }
    }

    try {
      // Support sync returns (e.g., p => p) or async (p.getBlockNumber())
      const result = await withTimeout(callFn(provider), perCallTimeoutMs, 'rpc call timeout');

      // mark success
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
      lastErr = err;
      const msg = err?.info?.responseBody || err?.message || '';
      const code = err?.code || 'UNKNOWN_ERROR';

      console.warn(`⚠️ [${key}] RPC Error: ${err.message || code}`);
      if (err?.code) console.warn(`🔍 RPC failure code: ${err.code}`);
      const current = getProvider(key);
      const st = chains[key];
      const failUrl =
        current?._rpcUrl ||
        (st.endpoints[st.pinnedIdx ?? -1] && st.endpoints[st.pinnedIdx ?? -1].url) ||
        'unknown';
      console.warn(`🔻 RPC failed [${key}]: ${failUrl}`);

      // Special handling: Ape batch limit
      const isApeBatchLimit = key === 'ape' && msg.includes('Batch of more than 3 requests');
      if (isApeBatchLimit) {
        console.warn('⛔ ApeChain batch limit hit — skip batch, no retry');
        return null;
      }

      // Rotate on typical transient issues
      const shouldRotate =
        msg.includes('no response') ||
        msg.includes('429') ||
        msg.includes('timeout') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('EHOSTUNREACH') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ECONNRESET') ||
        msg.includes('network error') ||
        msg.includes('could not coalesce') ||
        msg.includes('invalid block range') ||
        msg.includes('failed to fetch') ||
        msg.includes('504') ||
        msg.includes('503') ||
        msg.includes('Bad Gateway') ||
        msg.includes('Gateway Time-out') ||
        msg.includes('API key is not allowed') ||
        msg.includes("'eth_getLogs' is unavailable");

      await rotateProvider(key);
      await sleep(jitter(300 + i * 200));
      if (!shouldRotate) {
        // Even if not in list, we still rotated once; next loop will try again.
      }
    }
  }

  console.error(`❌ All retries failed for ${key}. Returning null.`);
  return null;
}

// Max batch size per chain (unchanged)
function getMaxBatchSize(chain = 'base') {
  return (chain || 'base').toLowerCase() === 'ape' ? 3 : 10;
}

module.exports = {
  getProvider,
  rotateProvider,
  safeRpcCall,
  getMaxBatchSize
};





