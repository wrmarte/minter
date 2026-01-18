// services/lurker/sources/reservoir.js
// ======================================================
// LURKER: Reservoir adapter with Railway-safe proxy support
// - If RESERVOIR_PROXY_URL is set, ALL calls go through it
// - Proxy uses: /reservoir?chain=<base|eth>&p=<encoded path+query>
// - Secured with x-lurker-proxy-key (LURKER_PROXY_KEY)
// - Supports Cloudflare Access Service Tokens:
//     CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET
// ======================================================

const fetch = require("node-fetch");

function s(v) { return String(v || "").trim(); }
function chainNorm(v) { return s(v).toLowerCase(); }
function debugOn() { return String(process.env.LURKER_DEBUG || "0").trim() === "1"; }

function headersForChain(chain) {
  const h = { accept: "application/json" };
  const key = s(process.env.RESERVOIR_API_KEY);
  if (key) h["x-api-key"] = key;

  const c = chainNorm(chain);
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

async function fetchJson({ chain, urlPathWithQuery }) {
  const c = chainNorm(chain);

  const proxy = s(process.env.RESERVOIR_PROXY_URL);
  if (proxy) {
    const key = s(process.env.LURKER_PROXY_KEY);

    // Cloudflare Access service token headers (optional)
    const cfId = s(process.env.CF_ACCESS_CLIENT_ID);
    const cfSecret = s(process.env.CF_ACCESS_CLIENT_SECRET);

    const proxUrl =
      proxy.replace(/\/+$/, "") +
      `/reservoir?chain=${encodeURIComponent(c)}&p=${encodeURIComponent(urlPathWithQuery)}`;

    if (debugOn()) {
      console.log(
        `[LURKER][reservoir] viaProxy=${proxy} key=${key ? "set" : "missing"} cfAccess=${(cfId && cfSecret) ? "set" : "missing"}`
      );
    }

    const res = await fetch(proxUrl, {
      headers: {
        accept: "application/json",
        ...(key ? { "x-lurker-proxy-key": key } : {}),
        ...(cfId && cfSecret ? {
          "CF-Access-Client-Id": cfId,
          "CF-Access-Client-Secret": cfSecret
        } : {}),
      },
      timeout: 15000
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Proxy ${res.status}: ${txt.slice(0, 220)}`);
    }

    return await res.json();
  }

  // Direct mode (will fail on Railway if Reservoir is blocked)
  const base = "https://api.reservoir.tools";
  const fullUrl = base + urlPathWithQuery;

  if (debugOn()) console.log(`[LURKER][reservoir] direct baseUsed=${base}`);

  const res = await fetch(fullUrl, {
    headers: headersForChain(c),
    timeout: 12000
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Reservoir ${res.status}: ${txt.slice(0, 220)}`);
  }
  return await res.json();
}

async function fetchListings({ chain, contract, limit = 20 }) {
  const c = chainNorm(chain);
  const contractL = s(contract).toLowerCase();

  const qs = [];
  qs.push(`contracts=${encodeURIComponent(contractL)}`);
  qs.push(`sortBy=createdAt`);
  qs.push(`limit=${encodeURIComponent(String(limit))}`);
  qs.push(`includeMetadata=true`);

  const path = `/orders/asks/v5?${qs.join("&")}`;
  const data = await fetchJson({ chain: c, urlPathWithQuery: path });

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
      contract: contractL,
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

async function fetchTokenRarity({ chain, contract, tokenId }) {
  const c = chainNorm(chain);
  const token = `${s(contract).toLowerCase()}:${s(tokenId)}`;

  const path = `/tokens/v6?tokens=${encodeURIComponent(token)}&includeTopBid=false&includeAttributes=true`;
  const data = await fetchJson({ chain: c, urlPathWithQuery: path });

  const t = Array.isArray(data?.tokens) ? data.tokens[0] : null;
  const md = t?.token?.metadata || {};
  const rank = md?.rarityRank ?? md?.rarity_rank ?? null;

  return rank != null ? Number(rank) : null;
}

module.exports = { fetchListings, fetchTokenRarity };


