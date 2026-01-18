// services/lurker/sources/reservoir.js
// ======================================================
// LURKER: Reservoir source adapter (listings + token rarity)
// FIX:
// - Base should NOT default to api-base.reservoir.tools (DNS ENOTFOUND in some envs)
// - Default Base host: https://api.reservoir.tools with Base headers (x-chain-id=8453)
// - api-base can still be used ONLY if you force it via RESERVOIR_BASE_BASEURL
// - Logs baseUsed when LURKER_DEBUG=1 so you can verify runtime behavior
// ======================================================

const fetch = require("node-fetch");

// Cache: last-known-good base URL per chain (so we stop hammering dead domains)
const GOOD_BASE_BY_CHAIN = new Map();

function s(v) {
  return String(v || "").trim();
}
function chainNorm(v) {
  return s(v).toLowerCase();
}
function debugOn() {
  return String(process.env.LURKER_DEBUG || "0").trim() === "1";
}

function dedupe(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const v = s(x).replace(/\/+$/, "");
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Candidates per chain (env overrides are first)
function candidateBaseUrls(chain) {
  const c = chainNorm(chain);

  const envEth = s(process.env.RESERVOIR_ETH_BASEURL);
  const envBase = s(process.env.RESERVOIR_BASE_BASEURL);
  const envApe = s(process.env.RESERVOIR_APE_BASEURL);

  // IMPORTANT:
  // You were failing on `api-base.reservoir.tools` (ENOTFOUND).
  // So Base must default to `api.reservoir.tools` with Base headers.
  if (c === "base") {
    const list = [];
    if (envBase) list.push(envBase);

    // safest default
    list.push("https://api.reservoir.tools");

    // NOTE: we DO NOT include api-base by default anymore.
    // If you REALLY want to try api-base, you must set:
    // RESERVOIR_BASE_BASEURL=https://api-base.reservoir.tools
    return dedupe(list);
  }

  if (c === "eth") {
    const list = [];
    if (envEth) list.push(envEth);
    list.push("https://api.reservoir.tools");
    return dedupe(list);
  }

  if (c === "ape") {
    // Placeholder until you decide marketplace/indexer for ApeChain
    const list = [];
    if (envApe) list.push(envApe);
    return dedupe(list);
  }

  // default
  return dedupe(["https://api.reservoir.tools"]);
}

function headersForChain(chain) {
  const h = { accept: "application/json" };
  const key = s(process.env.RESERVOIR_API_KEY);
  if (key) h["x-api-key"] = key;

  const c = chainNorm(chain);
  if (c === "base") {
    // Base routing headers
    h["x-chain-id"] = "8453";
    h["x-chain"] = "base";
    h["x-reservoir-chain"] = "base";
  } else if (c === "eth") {
    h["x-chain-id"] = "1";
    h["x-chain"] = "ethereum";
    h["x-reservoir-chain"] = "ethereum";
  }

  return h;
}

// Try each host until success; cache the winner
async function fetchJsonWithFallback({ chain, urlPathWithQuery }) {
  const c = chainNorm(chain);

  const cachedGood = GOOD_BASE_BY_CHAIN.get(c);
  const candidates = cachedGood
    ? dedupe([cachedGood, ...candidateBaseUrls(c)])
    : candidateBaseUrls(c);

  let lastErr = null;

  for (const base of candidates) {
    try {
      const fullUrl = base.replace(/\/+$/, "") + urlPathWithQuery;

      const res = await fetch(fullUrl, {
        headers: headersForChain(c),
        timeout: 12000
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Reservoir ${res.status}: ${txt.slice(0, 220)}`);
      }

      const data = await res.json();
      GOOD_BASE_BY_CHAIN.set(c, base);

      if (debugOn()) {
        console.log(`[LURKER][reservoir] chain=${c} baseUsed=${base}`);
      }

      return { data, baseUsed: base };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  if (debugOn()) {
    console.log(`[LURKER][reservoir] chain=${c} ALL_HOSTS_FAILED candidates=${JSON.stringify(candidates)}`);
  }

  throw lastErr || new Error("Reservoir: all base URLs failed");
}

// Fetch newest asks (no continuation here — live poller should always grab newest page)
async function fetchListings({ chain, contract, limit = 20 }) {
  const c = chainNorm(chain);

  const qs = [];
  qs.push(`contracts=${encodeURIComponent(String(contract || "").toLowerCase())}`);
  qs.push(`sortBy=createdAt`);
  qs.push(`limit=${encodeURIComponent(String(limit))}`);
  qs.push(`includeMetadata=true`);

  const path = `/orders/asks/v5?${qs.join("&")}`;
  const { data } = await fetchJsonWithFallback({ chain: c, urlPathWithQuery: path });

  const orders = Array.isArray(data?.orders) ? data.orders : [];
  const listings = orders.map((o) => {
    const token = o?.token || {};
    const price = o?.price || {};
    const meta = token?.metadata || {};

    const attrs = Array.isArray(meta?.attributes) ? meta.attributes : [];
    const traits = {};
    for (const a of attrs) {
      const k = s(a?.key || a?.trait_type);
      const v = s(a?.value);
      if (k && v) {
        if (!traits[k]) traits[k] = [];
        traits[k].push(v);
      }
    }

    return {
      source: "reservoir",
      chain: c,
      contract: String(contract || "").toLowerCase(),
      listingId: s(o?.id || o?.orderId || o?.order?.id),
      tokenId: s(token?.tokenId),
      name: s(meta?.name),
      image: s(meta?.image),
      openseaUrl: s(token?.openseaUrl || token?.externalUrl),
      rarityRank: meta?.rarityRank ?? meta?.rarity_rank ?? null,
      traits,
      priceNative: price?.amount?.native ?? price?.amount?.decimal ?? null,
      priceCurrency: price?.currency?.symbol || null,
      createdAt: o?.createdAt || null,
      raw: o,
    };
  }).filter(x => x.listingId && x.tokenId);

  return { listings };
}

// Fallback: fetch token details to get rarityRank if asks feed doesn't include it
async function fetchTokenRarity({ chain, contract, tokenId }) {
  const c = chainNorm(chain);
  const token = `${String(contract || "").toLowerCase()}:${String(tokenId || "")}`;

  const path = `/tokens/v6?tokens=${encodeURIComponent(token)}&includeTopBid=false&includeAttributes=true`;
  const { data } = await fetchJsonWithFallback({ chain: c, urlPathWithQuery: path });

  const t = Array.isArray(data?.tokens) ? data.tokens[0] : null;
  const md = t?.token?.metadata || {};
  const rank = md?.rarityRank ?? md?.rarity_rank ?? null;

  return rank != null ? Number(rank) : null;
}

module.exports = { fetchListings, fetchTokenRarity };

