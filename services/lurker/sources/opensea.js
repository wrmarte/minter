// services/lurker/sources/opensea.js
// ======================================================
// LURKER: OpenSea listings source (events feed)
// - Uses OpenSea "created" events to detect new listings
// - Normalizes to Lurker listing objects
//
// ENV:
//   OPENSEA_API_KEY=... (recommended)
//   OPENSEA_BASE_URL=https://api.opensea.io (optional override)
// ======================================================

const fetch = require("node-fetch");

function s(v) { return String(v || "").trim(); }
function chainNorm(v) { return s(v).toLowerCase(); }
function debugOn() { return String(process.env.LURKER_DEBUG || "0").trim() === "1"; }

function osBase() {
  return s(process.env.OPENSEA_BASE_URL || "https://api.opensea.io").replace(/\/+$/, "");
}

function osHeaders() {
  const h = { accept: "application/json" };
  const key = s(process.env.OPENSEA_API_KEY);
  if (key) h["x-api-key"] = key;
  return h;
}

// Convert wei string -> decimal ETH string (best effort)
function weiToEthStr(weiStr) {
  try {
    const w = BigInt(String(weiStr || "0"));
    const whole = w / 1000000000000000000n;
    const frac = w % 1000000000000000000n;
    if (frac === 0n) return whole.toString();

    // trim to 6 decimals for display
    const fracStr = frac.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return null;
  }
}

async function fetchListings({ chain, contract, limit = 20 }) {
  const c = chainNorm(chain);
  const contractL = s(contract).toLowerCase();

  // OpenSea v1 events endpoint (widely used historically)
  // NOTE: For Base, OpenSea coverage depends on collection support.
  const qs = [];
  qs.push(`event_type=created`);
  qs.push(`asset_contract_address=${encodeURIComponent(contractL)}`);
  qs.push(`only_opensea=false`);
  qs.push(`offset=0`);
  qs.push(`limit=${encodeURIComponent(String(Math.min(50, Math.max(1, limit))))}`);

  const url = `${osBase()}/api/v1/events?${qs.join("&")}`;

  if (debugOn()) console.log(`[LURKER][opensea] url=${url}`);

  const res = await fetch(url, { headers: osHeaders(), timeout: 15000 });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenSea ${res.status}: ${txt.slice(0, 220)}`);
  }

  const data = await res.json();
  const events = Array.isArray(data?.asset_events) ? data.asset_events : [];

  const listings = events.map(ev => {
    const asset = ev?.asset || {};
    const tokenId = s(asset?.token_id);
    const listingId = s(ev?.id || ev?.order_hash || ev?.transaction?.transaction_hash || `${contractL}:${tokenId}:${ev?.created_date || ""}`);

    // price fields vary; use starting_price if present
    const priceNative = ev?.starting_price != null ? weiToEthStr(ev.starting_price) : null;

    const payment = ev?.payment_token || {};
    const currency = s(payment?.symbol) || (c === "base" ? "ETH" : "ETH");

    const image = s(asset?.image_url || asset?.image_preview_url || asset?.image_thumbnail_url);
    const name = s(asset?.name);
    const openseaUrl = s(asset?.permalink);

    // Traits sometimes come through as "traits" array, but unreliable -> we fetch via Moralis later
    let traits = {};
    if (asset?.traits && typeof asset.traits === "object" && !Array.isArray(asset.traits)) {
      // sometimes returns object map
      traits = asset.traits;
    } else if (Array.isArray(asset?.traits)) {
      // array of {trait_type, value}
      for (const t of asset.traits) {
        const k = s(t?.trait_type);
        const v = s(t?.value);
        if (!k || !v) continue;
        if (!traits[k]) traits[k] = [];
        traits[k].push(v);
      }
    }

    const seller = s(ev?.seller?.address || ev?.from_account?.address);

    return {
      source: "opensea",
      chain: c,
      contract: contractL,
      listingId,
      tokenId,
      name,
      image,
      openseaUrl,
      seller,
      rarityRank: null, // computed later
      rarityScore: null,
      traits,
      priceNative: priceNative != null ? priceNative : null,
      priceCurrency: currency || null,
      createdAt: ev?.created_date || ev?.created_at || null,
      raw: ev,
    };
  }).filter(x => x.listingId && x.tokenId);

  return { listings };
}

module.exports = { fetchListings };
