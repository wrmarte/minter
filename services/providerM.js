// services/providerM.js
const { JsonRpcProvider, Network } = require("ethers");
const fetch = require("node-fetch");

/* =========================================================
   Resilient multi-chain provider manager with dynamic RPCs
   - Chains: eth(1), base(8453), ape(33139)
   - Auto-fetch RPC lists at startup & every 6h (OPTIONAL)
   - Per-endpoint backoff + per-chain cooldown + timeouts
   - Static network hints (prevents ethers network-detect retries)
   - Never throws from public APIs; returns null on failure

   ✅ PATCH NOTES (IMPORTANT)
   1) Fixes: "staticNetwork.matches is not a function"
      - You were passing boolean to options.staticNetwork.
      - ethers expects a Network (or Networkish converted to Network).
   2) Disables unstable/gated RPC discovery by default
      - Stops adding endpoints like developer-access-mainnet.base.org, tenderly gateway, etc.
   3) Improves timeout/backoff defaults to reduce log spam.
========================================================= */

/* ---------- RPC discovery toggle (DEFAULT OFF) ---------- */
const RPC_DISCOVERY_ENABLED =
  String(process.env.RPC_DISCOVERY_ENABLED || "0").trim() === "1";

/* ---------- Blocklist for known gated/flaky endpoints ---------- */
const RPC_BLOCKLIST = [
  "developer-access-mainnet.base.org",
  "base.gateway.tenderly.co",
  "gateway.tenderly.co",
  "tenderly.co",
  "alchemy.com", // optional, often requires key
  "infura.io",   // optional, requires key
  "blastapi.io", // optional, sometimes key/limits
].map((s) => s.toLowerCase());

function isBlockedUrl(url) {
  const u = String(url || "").toLowerCase();
  return RPC_BLOCKLIST.some((bad) => u.includes(bad));
}

/* ---------- Static baselines (always included) ---------- */
const STATIC_RPCS = {
  eth: [
    "https://eth.llamarpc.com",
    "https://1rpc.io/eth",
    "https://rpc.ankr.com/eth",
    "https://ethereum-rpc.publicnode.com",
  ],
  base: [
    "https://mainnet.base.org",
    "https://base.publicnode.com",
    "https://1rpc.io/base",
    "https://base.llamarpc.com",
    "https://base-rpc.publicnode.com",
  ],
  ape: [
    "https://rpc.apechain.com",
    "https://rpc1.apexchain.xyz",
    "https://rpc.apexnetwork.xyz",
    "https://api.ape-rpc.com",
    "https://apex.rpc.thirdweb.com",
    "https://apexchain.alt.technology",
    "https://apex-mainnet.rpc.karzay.com",
    "https://apechain-rpc.publicnode.com",
    "https://rpc.apechain.io",
    "https://apechain.drpc.org",
    "https://rpc.apechain.p2p.org",
  ],
};

/* ---------- Mutable working set (will refresh if discovery enabled) ---------- */
const RPCS = {
  eth: [...STATIC_RPCS.eth],
  base: [...STATIC_RPCS.base],
  ape: [...STATIC_RPCS.ape],
};

/* ---------- Chain metadata (STATIC NETWORK HINTS) ---------- */
const CHAIN_META = {
  eth: { chainId: 1, network: { name: "homestead", chainId: 1 } },
  base: { chainId: 8453, network: { name: "base", chainId: 8453 } },
  ape: { chainId: 33139, network: { name: "apechain", chainId: 33139 } },
};

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/* ---------- Internal state ---------- */
const chains = {}; // key -> { endpoints[], pinnedIdx, chainCooldownUntil, lastOfflineLogAt }
const selectLocks = new Map(); // key -> Promise|null (serialize selection)

function now() {
  return Date.now();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter(ms) {
  return Math.floor(ms * (0.85 + Math.random() * 0.3));
}
function isThenable(x) {
  return x && typeof x.then === "function";
}

/* ---------- URL normalization (strip trailing slashes) ---------- */
function normalizeUrl(u) {
  if (!u || typeof u !== "string") return u;
  u = u.trim();
  try {
    const url = new URL(u);
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
      if (url.pathname === "") url.pathname = "/";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return u.replace(/\/+$/, "");
  }
}

function uniqueHttps(list) {
  const out = [];
  const seen = new Set();
  for (let url of list) {
    if (!url || typeof url !== "string") continue;
    url = normalizeUrl(url);
    if (!url.startsWith("https://")) continue;
    if (/\$\{[^}]+\}/.test(url)) continue; // skip placeholders
    if (isBlockedUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/* ---------- Promise/thenable-safe timeout ---------- */
function withTimeout(resultOrPromise, ms, reason = "timeout") {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(reason));
      }
    }, ms);

    const ok = (v) => {
      if (!settled) {
        settled = true;
        clearTimeout(t);
        resolve(v);
      }
    };
    const err = (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(t);
        reject(e);
      }
    };

    try {
      if (isThenable(resultOrPromise)) resultOrPromise.then(ok, err);
      else ok(resultOrPromise);
    } catch (e) {
      err(e);
    }
  });
}

/* ---------- Init & rebuild ---------- */
function initChain(key) {
  if (chains[key]) return;

  const merged = uniqueHttps(RPCS[key] || []);
  chains[key] = {
    endpoints: merged.map((url) => ({
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

function rebuildChainEndpoints(key) {
  const st = chains[key];
  if (!st) return;
  const merged = uniqueHttps(RPCS[key] || []);
  st.endpoints = merged.map((url) => ({
    url,
    provider: null,
    failCount: 0,
    cooldownUntil: 0,
    lastOkAt: 0,
  }));
  st.pinnedIdx = null;
}

/* ---------- Provider & scoring ---------- */
function toNetwork(key) {
  const meta = CHAIN_META[key] || {};
  const netish = meta.network || null;

  // Convert to a real Network when possible (prevents staticNetwork.matches error)
  try {
    if (Network && typeof Network.from === "function" && netish) {
      return Network.from(netish);
    }
  } catch {
    // fall through
  }

  return netish; // networkish object is still acceptable in most ethers paths
}

function makeProvider(key, url) {
  const u = normalizeUrl(url);

  const net = toNetwork(key);

  // ✅ FIX: staticNetwork must be Network/Networkish, NOT boolean
  // Also we pass the same network in arg2 to avoid detect.
  const p = new JsonRpcProvider(u, net, { staticNetwork: net });

  p._rpcUrl = u;
  p.pollingInterval = 8000;
  return p;
}

async function pingProvider(provider, timeoutMs = 4500) {
  try {
    const res = await withTimeout(
      provider.getBlockNumber(),
      timeoutMs,
      "rpc ping timeout"
    );
    return Number.isInteger(res) && res >= 0;
  } catch {
    return false;
  }
}

function scoreEndpoint(ep) {
  const cd = Math.max(0, ep.cooldownUntil - now());
  const penalty = ep.failCount * 1500;
  const recency = ep.lastOkAt ? Math.max(0, now() - ep.lastOkAt) / 1000 : 9999;
  return cd + penalty + recency; // lower is better
}

/* ---------- Selection (serialized per-chain) ---------- */
async function selectHealthy(key) {
  initChain(key);
  if (selectLocks.get(key)) return selectLocks.get(key);

  const run = (async () => {
    const st = chains[key];
    if (now() < st.chainCooldownUntil) return null;

    // reuse pinned if not cooling
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

      const ok = await pingProvider(ep.provider, 4500);
      if (ok) {
        ep.failCount = 0;
        ep.cooldownUntil = 0;
        ep.lastOkAt = now();
        st.pinnedIdx = idx;
        console.log(`✅ ${key} initialized/pinned RPC: ${ep.url}`);
        return ep.provider;
      }

      ep.failCount += 1;
      // ✅ sane exponential backoff (caps at 30s)
      const backoff = Math.min(30000, 1000 * (2 ** Math.min(6, ep.failCount)));
      ep.cooldownUntil = now() + jitter(backoff);
    }

    // all failed -> chain cooldown
    st.pinnedIdx = null;
    st.chainCooldownUntil = now() + 20000;
    if (now() - st.lastOfflineLogAt > 60000) {
      console.warn(`⛔ ${key} RPC appears offline. Cooling down 20s.`);
      st.lastOfflineLogAt = now();
    }
    return null;
  })();

  selectLocks.set(key, run);
  try {
    return await run;
  } finally {
    selectLocks.delete(key);
  }
}

/* ---------- Public API ---------- */
function getProvider(chain = "base") {
  const key = (chain || "base").toLowerCase();
  initChain(key);

  const st = chains[key];
  if (now() < st.chainCooldownUntil) {
    console.warn(
      `⚠️ No live provider for "${key}". Returning null (chain cooldown).`
    );
    return null;
  }

  if (st.pinnedIdx == null) return null;

  const ep = st.endpoints[st.pinnedIdx];
  if (!ep || now() < ep.cooldownUntil) return null;

  if (!ep.provider) ep.provider = makeProvider(key, ep.url);
  return ep.provider;
}

async function rotateProvider(chain = "base") {
  const key = (chain || "base").toLowerCase();
  initChain(key);

  const st = chains[key];
  if (st.pinnedIdx != null) {
    const ep = st.endpoints[st.pinnedIdx];
    if (ep) {
      ep.failCount += 1;
      const backoff = Math.min(30000, 1000 * (2 ** Math.min(6, ep.failCount)));
      ep.cooldownUntil = now() + jitter(backoff);
      console.warn(
        `🔁 Rotated RPC for ${key}: ${ep.url} cooling down ~${Math.round(
          backoff / 1000
        )}s`
      );
    }
  }

  st.pinnedIdx = null;
  await selectHealthy(key);
}

async function safeRpcCall(chain, callFn, retries = 5, perCallTimeoutMs = 15000) {
  const key = (chain || "base").toLowerCase();
  initChain(key);

  for (let i = 0; i < retries; i++) {
    let provider = getProvider(key);
    if (!provider) {
      provider = await selectHealthy(key);
      if (!provider) {
        await sleep(jitter(400 + i * 250));
        continue;
      }
    }

    try {
      const result = await withTimeout(
        callFn(provider),
        perCallTimeoutMs,
        "rpc call timeout"
      );

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
      const msg = err?.info?.responseBody || err?.message || "";
      console.warn(`⚠️ [${key}] RPC Error: ${err?.message || err}`);

      const current = getProvider(key);
      const st = chains[key];
      const failUrl =
        current?._rpcUrl ||
        (st.endpoints[st.pinnedIdx ?? -1] && st.endpoints[st.pinnedIdx ?? -1].url) ||
        "unknown";
      console.warn(`🔻 RPC failed [${key}]: ${failUrl}`);

      // Ape special-case
      if (key === "ape" && String(msg).includes("Batch of more than 3 requests")) {
        console.warn("⛔ ApeChain batch limit hit — skip batch, no retry");
        return null;
      }

      await rotateProvider(key);
      await sleep(jitter(500 + i * 350));
    }
  }

  console.error(`❌ All retries failed for ${key}. Returning null.`);
  return null;
}

function getMaxBatchSize(chain = "base") {
  // This is used by some modules as a safety ceiling; keep behavior.
  return (chain || "base").toLowerCase() === "ape" ? 3 : 10;
}

/* ---------- Dynamic RPC discovery (OPTIONAL / OFF by default) ---------- */
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
  if (rec.rpcUrls && typeof rec.rpcUrls === "object") {
    for (const k of Object.keys(rec.rpcUrls)) {
      const v = rec.rpcUrls[k];
      if (Array.isArray(v)) out.push(...v);
      else if (typeof v === "string") out.push(v);
      else if (v && typeof v.url === "string") out.push(v.url);
    }
  }
  return out;
}

async function discoverChainRpcs(chainId) {
  const collected = [];
  // Use only chainid.network (stable JSON). Chainlist pages are not reliable JSON.
  try {
    const list = await fetchJson("https://chainid.network/chains.json", 9000);
    if (Array.isArray(list)) {
      const rec = list.find((c) => c.chainId === chainId);
      if (rec) collected.push(...extractRpcUrlsFromChainRecord(rec));
    }
  } catch {}
  return uniqueHttps(collected);
}

async function refreshRpcPool(key, reason = "periodic") {
  if (!RPC_DISCOVERY_ENABLED) return;

  const meta = CHAIN_META[key];
  if (!meta?.chainId) return;

  try {
    const fresh = await discoverChainRpcs(meta.chainId);
    if (!fresh.length) return;

    const merged = uniqueHttps([
      ...(STATIC_RPCS[key] || []),
      ...fresh,
      ...(RPCS[key] || []),
    ]);

    const before = (RPCS[key] || []).join(",");
    RPCS[key] = merged;

    if (before !== RPCS[key].join(",")) {
      console.log(
        `🔄 ${key} RPC list updated (${reason}). Count=${RPCS[key].length}`
      );
      rebuildChainEndpoints(key);
      selectHealthy(key).catch(() => {});
    }
  } catch (e) {
    console.warn(
      `⚠️ ${key} RPC discovery failed (${reason}): ${e?.message || e}`
    );
  }
}

/* ---------- Bootstrap ---------- */
(async () => {
  // Clean + dedupe baseline lists
  for (const k of Object.keys(RPCS)) {
    RPCS[k] = uniqueHttps(RPCS[k] || []);
  }

  // Optional discovery
  await Promise.all([
    refreshRpcPool("eth", "startup"),
    refreshRpcPool("base", "startup"),
    refreshRpcPool("ape", "startup"),
  ]);

  // Initialize chains & try pinning one endpoint each
  for (const key of Object.keys(CHAIN_META)) {
    initChain(key);
    if (!chains[key].endpoints.length) {
      RPCS[key] = uniqueHttps([...(STATIC_RPCS[key] || [])]);
      rebuildChainEndpoints(key);
    }
    selectHealthy(key).catch(() => {});
  }

  // Periodic refresh (only if enabled)
  if (RPC_DISCOVERY_ENABLED) {
    setInterval(() => {
      for (const key of Object.keys(CHAIN_META)) {
        refreshRpcPool(key, "periodic");
      }
    }, REFRESH_INTERVAL_MS);
  }
})();

/* ---------- Exports ---------- */
module.exports = {
  getProvider,
  rotateProvider,
  safeRpcCall,
  getMaxBatchSize,
};


