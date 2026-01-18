// services/lurker/sources/reservoir.js
// ======================================================
// LURKER: Reservoir source adapter (listings)
// - Fetches recent asks for a contract
// - Returns normalized listing objects
// ======================================================

const fetch = require("node-fetch");

function baseUrlForChain(chain) {
  const c = String(chain || "").toLowerCase();
  if (c === "base") return (process.env.RESERVOIR_BASE_BASEURL || "").trim() || "https://api-base.reservoir.tools";
  if (c === "eth") return (process.env.RESERVOIR_ETH_BASEURL || "").trim() || "https://api.reservoir.tools";
  if (c === "ape") return (process.env.RESERVOIR_APE_BASEURL || "").trim(); // may be blank until you choose a provider
  return "https://api.reservoir.tools";
}

function headers() {
  const h = { "accept": "application/json" };
  const key = (process.env.RESERVOIR_API_KEY || "").trim();
  if (key) h["x-api-key"] = key;
  return h;
}

// Cursor-based pagination. We store cursor per rule in DB.
async function fetchListings({ chain, contract, cursor, limit = 20 }) {
  const base = baseUrlForChain(chain);
  if (!base) return { listings: [], nextCursor: null };

  // NOTE: Endpoint paths can differ across Reservoir versions.
  // We keep this in ONE place so swapping later is easy.
  const url = new URL(base.replace(/\/$/, "") + "/orders/asks/v5");
  url.searchParams.set("contracts", contract);
  url.searchParams.set("sortBy", "createdAt");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("includeMetadata", "true");
  if (cursor) url.searchParams.set("continuation", cursor);

  const res = await fetch(url.toString(), { headers: headers() });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Reservoir ${res.status}: ${txt.slice(0, 180)}`);
  }

  const data = await res.json();

  // Normalize: listings[] with fields we use downstream.
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  const listings = orders.map((o) => {
    const token = o?.token || {};
    const price = o?.price || {};
    const meta = token?.metadata || {};
    const attrs = Array.isArray(meta?.attributes) ? meta.attributes : []; // common
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
      chain: String(chain || "").toLowerCase(),
      contract: String(contract || "").toLowerCase(),
      listingId: String(o?.id || o?.orderId || o?.order?.id || ""),
      tokenId: String(token?.tokenId || ""),
      name: String(meta?.name || ""),
      image: String(meta?.image || ""),
      openseaUrl: String(token?.openseaUrl || token?.externalUrl || ""),
      rarityRank: meta?.rarityRank ?? meta?.rarity_rank ?? null,
      traits,
      // price normalization
      priceNative: price?.amount?.native ?? price?.amount?.decimal ?? null,
      priceCurrency: price?.currency?.symbol || null,
      createdAt: o?.createdAt || null,
      raw: o,
    };
  }).filter(x => x.listingId && x.tokenId);

  return { listings, nextCursor: data?.continuation || null };
}

module.exports = { fetchListings };
