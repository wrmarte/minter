// services/lurker/sources/reservoir.js
// ======================================================
// LURKER: Reservoir source adapter (listings + token rarity)
// - Fetches recent asks for a contract
// - Returns normalized listing objects
// - Robust Base fallback (handles api-base.reservoir.tools DNS failures)
// - Adds fetchTokenRarity() for rank fallback
// ======================================================

const fetch = require("node-fetch");

// Cache: last-known-good base URL per chain (so we stop hammering dead domains)
const GOOD_BASE_BY_CHAIN = new Map();

function dedupe(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const v = String(x || "").trim();
    if (!v) continue;
    const key = v.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// Candidates per chain (in order). Env overrides are prepended.
function candidateBaseUrls(chain) {
  const c = String(chain || "").toLowerCase();

  const envEth = (process.env.RESERVOIR_ETH_BASEURL || "").trim();
  const envBase = (process.env.RESERVOIR_BASE_BASEURL || "").trim();
  const envApe = (process.env.RESERVOIR_APE_BASEURL || "").trim();

  if (c === "base") {
    const list = [];
    if (envBase) list.push(envBase);
    list.push("https://api-base.reservoir.tools"); // may fail (DNS) in some envs
    list.push("https://api.reservoir.tools");      // fallback host (use Base headers)
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

  return dedupe(["https://api.reservoir.tools"]);
}

function headersForChain(chain) {
  const h = { accept: "application/json" };
  const key = (process.env.RESERVOIR_API_KEY || "").trim();
  if (key) h["x-api-key"] = key;

  const c = String(chain || "").toLowerCase();
  if (c === "base") {
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

// Try each host until success; cache the winner.
async function fetchJsonWithFallback({ chain, urlPathWithQuery }) {
  const c = String(chain || "").toLowerCase();

  const cachedGood = GOOD_BASE_BY_CHAIN.get(c);
  const candidates = cachedGood
    ? [cachedGood, ...candidateBaseUrls(c)]
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
      return { data, baseUsed: base };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  throw lastErr || new Error("Reservoir: all base URLs failed");
}

async function fetchListings({ chain, contract, limit = 20 }) {
  const c = String(chain || "").toLowerCase();

  const qs = [];
  qs.push(`contracts=${encodeURIComponent(String(contract || "").toLowerCase())}`);
  qs.push(`sortBy=createdAt`);
  qs.push(`limit=${encodeURIComponent(String(limit))}`);
  qs.push(`includeMetadata=true`);

  const path = `/orders/asks/v5?${qs.join("&")}`;

  const { data } = await fetchJsonWithFallback({
    chain: c,
    urlPathWithQuery: path
  });

  const orders = Array.isArray(data?.orders) ? data.orders : [];

  const listings = orders.map((o) => {
    const token = o?.token || {};
    const price = o?.price || {};
    const meta = token?.metadata || {};

    const attrs = Array.isArray(meta?.attributes) ? meta.attributes : [];
    const traits = {};
    for (const a of attrs) {
      const k = String(a?.key || a?.trait_type || "").trim();
      const v = String(a?.value || "").trim();
      if (k && v) {
        if (!traits[k]) traits[k] = [];
        traits[k].push(v);
      }
    }

    return {
      source: "reservoir",
      chain: c,
      contract: String(contract || "").toLowerCase(),
      listingId: String(o?.id || o?.orderId || o?.order?.id || ""),
      tokenId: String(token?.tokenId || ""),
      name: String(meta?.name || ""),
      image: String(meta?.image || ""),
      openseaUrl: String(token?.openseaUrl || token?.externalUrl || ""),
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
  const c = String(chain || "").toLowerCase();
  const token = `${String(contract || "").toLowerCase()}:${String(tokenId || "")}`;
  const path = `/tokens/v6?tokens=${encodeURIComponent(token)}&includeTopBid=false&includeAttributes=true`;

  const { data } = await fetchJsonWithFallback({
    chain: c,
    urlPathWithQuery: path
  });

  const t = Array.isArray(data?.tokens) ? data.tokens[0] : null;
  const md = t?.token?.metadata || {};
  const rank = md?.rarityRank ?? md?.rarity_rank ?? null;

  return rank != null ? Number(rank) : null;
}

module.exports = { fetchListings, fetchTokenRarity };

