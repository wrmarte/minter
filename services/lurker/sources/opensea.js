// services/lurker/sources/opensea.js
// ======================================================
// LURKER: OpenSea listings source
//
// PATCH:
// - Supports OpenSea V2 events feed by collection slug (recommended)
// - Falls back to legacy V1 events by contract ONLY if no slug provided
// - Robust parsing across response shapes
//
// ENV:
//   OPENSEA_API_KEY=... (recommended)
//   OPENSEA_BASE_URL=https://api.opensea.io
//
//   OPENSEA_TIMEOUT_MS=25000
//   OPENSEA_RETRIES=2
//   OPENSEA_RETRY_BASE_MS=600
//
//   OPENSEA_FAILS_TO_OPEN=3
//   OPENSEA_CIRCUIT_OPEN_MS=180000
//
//   OPENSEA_V2_EVENT_TYPE=listing    (default listing; you can override)
// ======================================================

const fetch = require("node-fetch");

function s(v) { return String(v || "").trim(); }
function lower(v) { return s(v).toLowerCase(); }
function chainNorm(v) { return lower(v); }
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
  if (key) h["x-api-key"] = key;
  return h;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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
function circuitSet(url, st) {
  FAIL_STATE.set(url, st);
}
function circuitReset(url) {
  FAIL_STATE.set(url, { fails: 0, openUntilMs: 0, lastErr: "" });
}

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

      // Try json; if it fails, capture raw
      let json = null;
      try {
        json = await res.json();
      } catch (e) {
        const txt = await res.text().catch(() => "");
        throw new Error(`OpenSea JSON parse failed: ${String(e?.message || e)} | body=${txt.slice(0, 220)}`);
      }

      circuitReset(url);
      return json;
    } catch (e) {
      lastErr = e;

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

    const fracStr = frac.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return null;
  }
}

function v2EventType() {
  return lower(process.env.OPENSEA_V2_EVENT_TYPE || "listing");
}

function mkAssetUrl(chain, contract, tokenId) {
  const c = chainNorm(chain);
  const addr = lower(contract);
  const tid = s(tokenId);
  if (c === "base") return `https://opensea.io/assets/base/${addr}/${tid}`;
  if (c === "eth" || c === "ethereum") return `https://opensea.io/assets/ethereum/${addr}/${tid}`;
  return `https://opensea.io/assets/${addr}/${tid}`;
}

function pickArrayCandidates(data) {
  // OpenSea has used different keys over time.
  // We try the most common patterns:
  if (Array.isArray(data?.asset_events)) return data.asset_events; // v1
  if (Array.isArray(data?.events)) return data.events;            // v2 common
  if (Array.isArray(data?.results)) return data.results;          // some paginated shapes
  if (Array.isArray(data)) return data;
  return [];
}

function parseTraitsFromAny(obj) {
  // OpenSea shapes may have traits/attributes arrays.
  const traits = {};

  const attrs = Array.isArray(obj?.traits) ? obj.traits
    : Array.isArray(obj?.attributes) ? obj.attributes
    : [];

  for (const a of attrs) {
    const k = s(a?.trait_type || a?.type || a?.key);
    const v = s(a?.value);
    if (!k || !v) continue;
    if (!traits[k]) traits[k] = [];
    traits[k].push(v);
  }

  // Some v2 shapes might already be {trait_type: value} objects; support lightly
  if (!attrs.length && obj?.traits && typeof obj.traits === "object" && !Array.isArray(obj.traits)) {
    for (const [k, v] of Object.entries(obj.traits)) {
      const kk = s(k);
      const vv = s(v);
      if (!kk || !vv) continue;
      if (!traits[kk]) traits[kk] = [];
      traits[kk].push(vv);
    }
  }

  return traits;
}

function normalizeV2Event(chain, fallbackContract, ev) {
  // We’ll try multiple likely field locations
  const nft = ev?.nft || ev?.asset || ev?.payload?.nft || ev?.payload?.asset || null;

  const contract =
    lower(nft?.contract || nft?.contract_address || nft?.asset_contract?.address || fallbackContract);

  const tokenId =
    s(nft?.identifier || nft?.token_id || nft?.tokenId || nft?.id);

  const image =
    s(nft?.image_url || nft?.image || nft?.image_url_original || nft?.image_preview_url || ev?.image_url);

  const name =
    s(nft?.name || ev?.item_name || ev?.name);

  const permalink =
    s(nft?.opensea_url || nft?.permalink || ev?.permalink || ev?.item_url) || mkAssetUrl(chain, contract, tokenId);

  // listingId: stable dedupe key
  const listingId = s(
    ev?.id ||
    ev?.event_id ||
    ev?.order_hash ||
    ev?.payload?.order_hash ||
    ev?.transaction?.transaction_hash ||
    `${contract}:${tokenId}:${ev?.event_timestamp || ev?.created_date || ""}`
  );

  // price: v2 shapes vary heavily; we do best effort
  // try wei-like strings
  let priceNative = null;
  let priceCurrency = null;

  const pay = ev?.payment || ev?.payment_token || ev?.payload?.payment || ev?.payload?.payment_token || null;
  priceCurrency = s(pay?.symbol || pay?.token_symbol || "") || (chainNorm(chain) === "base" ? "ETH" : "ETH");

  const weiLike =
    ev?.starting_price ||
    ev?.payload?.starting_price ||
    ev?.payload?.price ||
    ev?.price?.current?.value ||
    ev?.price?.value ||
    null;

  if (weiLike != null && String(weiLike).match(/^\d+$/)) {
    priceNative = weiToEthStr(String(weiLike));
  } else if (weiLike != null) {
    // maybe already decimal
    const x = Number(weiLike);
    if (Number.isFinite(x) && x > 0) priceNative = String(x);
  }

  const seller =
    s(ev?.seller || ev?.from_account?.address || ev?.maker || ev?.payload?.maker || nft?.owner) || null;

  const traits = parseTraitsFromAny(nft || ev || {});

  return {
    source: "opensea_v2",
    chain: chainNorm(chain),
    contract,
    listingId,
    tokenId,
    name: name || null,
    image: image || null,
    openseaUrl: permalink || null,
    seller,
    rarityRank: null,
    rarityScore: null,
    traits,
    priceNative: priceNative != null ? priceNative : null,
    priceCurrency: priceCurrency || null,
    createdAt: ev?.event_timestamp || ev?.created_date || ev?.created_at || null,
    raw: ev,
  };
}

function normalizeV1Event(chain, contract, ev) {
  const asset = ev?.asset || {};
  const tokenId = s(asset?.token_id);
  const contractL = lower(contract);

  const listingId = s(
    ev?.id ||
    ev?.order_hash ||
    ev?.transaction?.transaction_hash ||
    `${contractL}:${tokenId}:${ev?.created_date || ""}`
  );

  const priceNative = ev?.starting_price != null ? weiToEthStr(ev.starting_price) : null;

  const payment = ev?.payment_token || {};
  const currency = s(payment?.symbol) || (chainNorm(chain) === "base" ? "ETH" : "ETH");

  const image = s(asset?.image_url || asset?.image_preview_url || asset?.image_thumbnail_url);
  const name = s(asset?.name);
  const openseaUrl = s(asset?.permalink) || mkAssetUrl(chain, contractL, tokenId);

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
    chain: chainNorm(chain),
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
}

async function fetchListings({ chain, contract, openseaSlug = null, limit = 20 }) {
  const c = chainNorm(chain);
  const contractL = lower(contract);
  const lim = Math.min(50, Math.max(1, Number(limit) || 20));

  // V2 path (preferred) if slug exists
  const slug = lower(openseaSlug || "");
  if (slug) {
    const et = v2EventType();
    const url = `${osBase()}/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=${encodeURIComponent(et)}&limit=${encodeURIComponent(String(lim))}`;

    if (debugOn()) console.log(`[LURKER][opensea:v2] url=${url}`);

    const data = await fetchJsonRetry(url, { headers: osHeaders() });

    if (debugOn()) {
      const keys = data && typeof data === "object" ? Object.keys(data).slice(0, 12) : [];
      console.log(`[LURKER][opensea:v2] respKeys=${keys.join(",") || "(none)"} type=${typeof data}`);
    }

    let events = pickArrayCandidates(data);

    // If v2 returns 0, try a secondary event_type fallback automatically
    if (!events.length && et !== "listing") {
      // no-op; they customized it
    } else if (!events.length && et === "listing") {
      // Some environments use "listings" (rare but happens in wrappers)
      const url2 = `${osBase()}/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=listings&limit=${encodeURIComponent(String(lim))}`;
      if (debugOn()) console.log(`[LURKER][opensea:v2] fallback url=${url2}`);
      const data2 = await fetchJsonRetry(url2, { headers: osHeaders() });
      events = pickArrayCandidates(data2);
    }

    const listings = events
      .map(ev => normalizeV2Event(c, contractL, ev))
      .filter(x => x.listingId && x.tokenId);

    return { listings };
  }

  // V1 fallback (legacy) only if no slug
  const qs = [];
  qs.push(`event_type=created`);
  qs.push(`asset_contract_address=${encodeURIComponent(contractL)}`);
  qs.push(`only_opensea=false`);
  qs.push(`offset=0`);
  qs.push(`limit=${encodeURIComponent(String(lim))}`);

  const url = `${osBase()}/api/v1/events?${qs.join("&")}`;

  if (debugOn()) console.log(`[LURKER][opensea:v1] url=${url}`);

  const data = await fetchJsonRetry(url, { headers: osHeaders() });
  const events = pickArrayCandidates(data);

  const listings = events
    .map(ev => normalizeV1Event(c, contractL, ev))
    .filter(x => x.listingId && x.tokenId);

  return { listings };
}

module.exports = { fetchListings };

