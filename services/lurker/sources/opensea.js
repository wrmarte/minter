// services/lurker/sources/opensea.js
// ======================================================
// LURKER: OpenSea listings source
//
// Supports:
// - v2 (recommended): /api/v2/events/collection/{slug}?event_type=listing&limit=25
// - v1 (fallback/legacy): /api/v1/events?event_type=created&asset_contract_address=...
//
// ENV:
//   OPENSEA_API_KEY=... (recommended)
//   OPENSEA_BASE_URL=https://api.opensea.io (optional override)
//
//   OPTIONAL (safe defaults):
//   OPENSEA_TIMEOUT_MS=25000
//   OPENSEA_RETRIES=2
//   OPENSEA_RETRY_BASE_MS=600
//
//   CIRCUIT BREAKER:
//   OPENSEA_FAILS_TO_OPEN=3
//   OPENSEA_CIRCUIT_OPEN_MS=180000
// ======================================================

const fetch = require("node-fetch");

function s(v) { return String(v || "").trim(); }
function lower(v) { return s(v).toLowerCase(); }
function debugOn() { return String(process.env.LURKER_DEBUG || "0").trim() === "1"; }

function osBase() {
  return s(process.env.OPENSEA_BASE_URL || "https://api.opensea.io").replace(/\/+$/, "");
}

function osHeaders() {
  const h = {
    accept: "application/json",
    "user-agent": "MuscleMB-LURKER/1.0 (+https://railway.app)"
  };
  const key = s(process.env.OPENSEA_API_KEY);
  if (key) {
    // OpenSea commonly accepts X-API-KEY; keep x-api-key too
    h["X-API-KEY"] = key;
    h["x-api-key"] = key;
  }
  return h;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function jitter(ms) {
  const j = ms * 0.15;
  return Math.max(0, Math.floor(ms + (Math.random() * 2 - 1) * j));
}

function isAbortErr(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  const name = String(e?.name || "").toLowerCase();
  return name.includes("abort") || msg.includes("aborted") || msg.includes("abort");
}

// --- Circuit breaker state (per URL) ---
const FAIL_STATE = new Map(); // url -> { fails, openUntilMs, lastErr }

function circuitGet(url) {
  return FAIL_STATE.get(url) || { fails: 0, openUntilMs: 0, lastErr: "" };
}
function circuitSet(url, st) { FAIL_STATE.set(url, st); }
function circuitReset(url) { FAIL_STATE.set(url, { fails: 0, openUntilMs: 0, lastErr: "" }); }

async function fetchWithAbort(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonRetry(url, opts = {}) {
  const timeoutMs = Math.max(5000, num(process.env.OPENSEA_TIMEOUT_MS, 25000));
  const retries = Math.max(1, Math.min(6, num(process.env.OPENSEA_RETRIES, 2)));
  const baseBackoff = Math.max(150, num(process.env.OPENSEA_RETRY_BASE_MS, 600));

  const failsToOpen = Math.max(1, Math.min(20, num(process.env.OPENSEA_FAILS_TO_OPEN, 3)));
  const openMs = Math.max(30000, Math.min(30 * 60 * 1000, num(process.env.OPENSEA_CIRCUIT_OPEN_MS, 180000)));

  // Circuit breaker check
  const now = Date.now();
  const st0 = circuitGet(url);
  if (st0.openUntilMs && st0.openUntilMs > now) {
    const left = st0.openUntilMs - now;
    throw new Error(`OpenSea circuit open (${Math.ceil(left / 1000)}s remaining) — lastErr: ${st0.lastErr || "unknown"}`);
  }

  let lastErr = null;

  for (let i = 0; i < retries; i++) {
    try {
      // Progressive timeout per attempt
      const attemptTimeout = Math.min(45000, timeoutMs + i * 5000);

      const res = await fetchWithAbort(url, opts, attemptTimeout);

      if (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) {
        const ra = s(res.headers.get("retry-after"));
        const waitMs = ra
          ? Math.min(30000, Math.max(500, Math.floor(Number(ra) * 1000)))
          : jitter(baseBackoff * Math.pow(2, i));
        const txt = await res.text().catch(() => "");
        throw new Error(`OpenSea ${res.status} (retry in ${waitMs}ms): ${txt.slice(0, 180)}`);
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`OpenSea ${res.status}: ${txt.slice(0, 220)}`);
      }

      const json = await res.json();

      // Success: reset circuit breaker
      circuitReset(url);

      return json;
    } catch (e) {
      lastErr = e;

      // Update circuit breaker state
      const st = circuitGet(url);
      st.fails += 1;
      st.lastErr = String(e?.message || e || "unknown").slice(0, 160);

      if (st.fails >= failsToOpen) {
        st.openUntilMs = Date.now() + openMs;
        circuitSet(url, st);
        throw new Error(`OpenSea circuit opened for ${Math.ceil(openMs / 1000)}s — ${st.lastErr}`);
      }

      circuitSet(url, st);

      const waitMs = jitter(baseBackoff * Math.pow(2, i));
      if (debugOn()) {
        const tag = isAbortErr(e) ? "abort/timeout" : "hard";
        console.log(`[LURKER][opensea] retry ${i + 1}/${retries} in ${waitMs}ms — (${tag}) ${e?.message || e}`);
      }
      if (i < retries - 1) await sleep(waitMs);
    }
  }

  throw lastErr || new Error("OpenSea fetch failed");
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

function pick(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    const parts = p.split(".");
    let ok = true;
    for (const part of parts) {
      if (!cur || typeof cur !== "object" || !(part in cur)) { ok = false; break; }
      cur = cur[part];
    }
    if (ok && cur != null) return cur;
  }
  return null;
}

function parseTokenIdFromEvent(ev) {
  const id =
    pick(ev, [
      "nft.identifier",
      "nft.token_id",
      "asset.token_id",
      "asset.tokenId",
      "token_id",
      "tokenId",
      "item.nft_id", // sometimes includes contract/token
    ]);

  if (id == null) return null;
  const raw = String(id);

  // Some APIs put "contract:tokenId"
  const parts = raw.split("/");
  const last = parts[parts.length - 1];
  const colon = last.split(":");
  return colon[colon.length - 1].trim();
}

function parseContractFromEvent(ev, fallbackContract) {
  const c =
    pick(ev, [
      "nft.contract",
      "nft.contract_address",
      "asset.asset_contract.address",
      "asset_contract.address",
      "contract_address",
      "contractAddress",
    ]);

  const out = c ? lower(c) : lower(fallbackContract || "");
  return out || null;
}

function parseImageFromEvent(ev) {
  const url =
    pick(ev, [
      "nft.image_url",
      "nft.imageUrl",
      "asset.image_url",
      "asset.image_preview_url",
      "asset.image_thumbnail_url",
      "asset.imageUrl",
    ]);
  return s(url);
}

function parseNameFromEvent(ev) {
  const name =
    pick(ev, [
      "nft.name",
      "asset.name",
      "asset.title",
      "name",
    ]);
  return s(name);
}

function parsePermalinkFromEvent(ev, chain, contract, tokenId) {
  const direct =
    pick(ev, [
      "nft.opensea_url",
      "nft.openseaUrl",
      "asset.permalink",
      "asset.opensea_url",
      "opensea_url",
      "permalink",
    ]);

  const d = s(direct);
  if (d) return d;

  // fallback
  const c = lower(chain);
  const addr = lower(contract);
  const tid = s(tokenId);
  if (!addr || !tid) return null;

  if (c === "base") return `https://opensea.io/assets/base/${addr}/${tid}`;
  if (c === "eth" || c === "ethereum") return `https://opensea.io/assets/ethereum/${addr}/${tid}`;
  return `https://opensea.io/assets/${addr}/${tid}`;
}

function parsePrice(ev) {
  // v2 often exposes payment.quantity + decimals; sometimes "price" already
  const q =
    pick(ev, [
      "payment.quantity",
      "payment_amount",
      "listing.payment.quantity",
      "listing.paymentAmount",
      "starting_price",
      "startingPrice",
      "price",
    ]);

  const decimals =
    pick(ev, [
      "payment.decimals",
      "listing.payment.decimals",
    ]);

  const sym =
    pick(ev, [
      "payment.symbol",
      "listing.payment.symbol",
      "payment_token.symbol",
      "payment_token_contract.symbol",
    ]);

  // If q is a large integer string, treat as wei unless decimals says otherwise
  const qs = q != null ? String(q) : "";
  if (!qs) return { priceNative: null, priceCurrency: null };

  const dec = decimals != null ? Number(decimals) : 18;
  let priceNative = null;

  if (Number.isFinite(dec) && dec === 18) {
    priceNative = weiToEthStr(qs);
  } else if (Number.isFinite(dec) && dec > 0) {
    // decimal shift
    try {
      const bi = BigInt(qs);
      const base = BigInt(10) ** BigInt(dec);
      const whole = bi / base;
      const frac = bi % base;
      const fracStr = frac.toString().padStart(dec, "0").slice(0, 6).replace(/0+$/, "");
      priceNative = fracStr ? `${whole}.${fracStr}` : whole.toString();
    } catch {
      priceNative = null;
    }
  } else {
    // maybe already decimal
    priceNative = qs;
  }

  const cur = sym ? String(sym).trim() : null;
  return { priceNative, priceCurrency: cur };
}

async function fetchListingsV2({ chain, contract, osSlug, limit = 25 }) {
  const slug = lower(osSlug);
  const qs = [];
  qs.push(`event_type=listing`);
  qs.push(`limit=${encodeURIComponent(String(Math.min(50, Math.max(1, limit))))}`);

  const url = `${osBase()}/api/v2/events/collection/${encodeURIComponent(slug)}?${qs.join("&")}`;

  if (debugOn()) console.log(`[LURKER][opensea:v2] url=${url}`);

  const data = await fetchJsonRetry(url, { headers: osHeaders() });

  // v2 commonly uses asset_events; be defensive
  const events =
    (Array.isArray(data?.asset_events) ? data.asset_events
      : Array.isArray(data?.events) ? data.events
      : Array.isArray(data?.assetEvents) ? data.assetEvents
      : []);

  const listings = events.map(ev => {
    const tokenId = parseTokenIdFromEvent(ev);
    const contractAddr = parseContractFromEvent(ev, contract);
    if (!tokenId || !contractAddr) return null;

    const listingId = s(ev?.id || ev?.event_id || ev?.order_hash || ev?.transaction?.transaction_hash || ev?.transaction_hash)
      || `${contractAddr}:${tokenId}:${s(ev?.event_timestamp || ev?.created_date || ev?.created_at || "")}`;

    const { priceNative, priceCurrency } = parsePrice(ev);

    const image = parseImageFromEvent(ev);
    const name = parseNameFromEvent(ev);
    const openseaUrl = parsePermalinkFromEvent(ev, chain, contractAddr, tokenId);

    const seller = s(
      pick(ev, [
        "maker.address",
        "maker",
        "seller.address",
        "seller",
        "from_account.address",
        "from_account",
      ])
    );

    // traits rarely present in v2 events; kept empty and filled via Moralis if needed
    const traits = {};

    return {
      source: "opensea_v2",
      chain: lower(chain),
      contract: lower(contractAddr),
      listingId,
      tokenId: s(tokenId),
      name,
      image,
      openseaUrl,
      seller: seller || null,
      rarityRank: null,
      rarityScore: null,
      traits,
      priceNative: priceNative != null ? priceNative : null,
      priceCurrency: priceCurrency || (lower(chain) === "base" ? "ETH" : "ETH"),
      createdAt: s(ev?.event_timestamp || ev?.created_date || ev?.created_at || null) || null,
      raw: ev,
    };
  }).filter(Boolean);

  return { listings };
}

// Legacy v1 fallback (not great for Base, but kept for safety)
async function fetchListingsV1({ chain, contract, limit = 20 }) {
  const contractL = lower(contract);

  const qs = [];
  qs.push(`event_type=created`);
  qs.push(`asset_contract_address=${encodeURIComponent(contractL)}`);
  qs.push(`only_opensea=false`);
  qs.push(`offset=0`);
  qs.push(`limit=${encodeURIComponent(String(Math.min(50, Math.max(1, limit))))}`);

  const url = `${osBase()}/api/v1/events?${qs.join("&")}`;

  if (debugOn()) console.log(`[LURKER][opensea:v1] url=${url}`);

  const data = await fetchJsonRetry(url, { headers: osHeaders() });
  const events = Array.isArray(data?.asset_events) ? data.asset_events : [];

  const listings = events.map(ev => {
    const asset = ev?.asset || {};
    const tokenId = s(asset?.token_id);
    const listingId = s(
      ev?.id ||
      ev?.order_hash ||
      ev?.transaction?.transaction_hash ||
      `${contractL}:${tokenId}:${ev?.created_date || ""}`
    );

    const priceNative = ev?.starting_price != null ? weiToEthStr(ev.starting_price) : null;

    const payment = ev?.payment_token || {};
    const currency = s(payment?.symbol) || (lower(chain) === "base" ? "ETH" : "ETH");

    const image = s(asset?.image_url || asset?.image_preview_url || asset?.image_thumbnail_url);
    const name = s(asset?.name);
    const openseaUrl = s(asset?.permalink);

    let traits = {};
    if (asset?.traits && typeof asset.traits === "object" && !Array.isArray(asset.traits)) {
      traits = asset.traits;
    } else if (Array.isArray(asset?.traits)) {
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
      source: "opensea_v1",
      chain: lower(chain),
      contract: contractL,
      listingId,
      tokenId,
      name,
      image,
      openseaUrl,
      seller,
      rarityRank: null,
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

async function fetchListings({ chain, contract, limit = 25, osSlug = null }) {
  const c = lower(chain);
  const addr = lower(contract);

  // Prefer v2 when slug is present
  if (osSlug) {
    return fetchListingsV2({ chain: c, contract: addr, osSlug, limit });
  }

  // fallback
  return fetchListingsV1({ chain: c, contract: addr, limit });
}

module.exports = { fetchListings };
