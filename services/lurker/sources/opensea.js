// services/lurker/sources/opensea.js
// ======================================================
// LURKER: OpenSea listings source
//
// Strategy:
//   1) If rule has os_slug (or url), try OpenSea v2 endpoints (slug-based)
//   2) Fallback to v1 events endpoint (contract-based)
//
// ENV:
//   OPENSEA_API_KEY=... (recommended)
//   OPENSEA_BASE_URL=https://api.opensea.io (optional override)
//   OPENSEA_TIMEOUT_MS=25000
//   OPENSEA_RETRIES=2
//   OPENSEA_RETRY_BASE_MS=600
//   OPENSEA_FAILS_TO_OPEN=3
//   OPENSEA_CIRCUIT_OPEN_MS=180000
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
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
function circuitGet(url) { return FAIL_STATE.get(url) || { fails: 0, openUntilMs: 0, lastErr: "" }; }
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

async function fetchTextRetry(url, opts = {}) {
  const timeoutMs = Math.max(5000, num(process.env.OPENSEA_TIMEOUT_MS, 25000));
  const retries = Math.max(1, Math.min(6, num(process.env.OPENSEA_RETRIES, 2)));
  const baseBackoff = Math.max(150, num(process.env.OPENSEA_RETRY_BASE_MS, 600));

  const failsToOpen = Math.max(1, Math.min(20, num(process.env.OPENSEA_FAILS_TO_OPEN, 3)));
  const openMs = Math.max(30000, Math.min(30 * 60 * 1000, num(process.env.OPENSEA_CIRCUIT_OPEN_MS, 180000)));

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

      if (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504 || res.status === 522) {
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

      const txt = await res.text().catch(() => "");

      circuitReset(url);
      return txt;
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

function tryJson(txt) {
  try { return JSON.parse(txt); } catch { return null; }
}

function extractSlug(osSlugOrUrl) {
  const raw = s(osSlugOrUrl);
  if (!raw) return null;

  // already slug
  if (!raw.includes("/") && !raw.includes(".") && !raw.includes("?")) return raw;

  // url parse
  try {
    const u = new URL(raw);
    const host = (u.hostname || "").toLowerCase();
    const path = (u.pathname || "").replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);

    if (host.includes("opensea.io")) {
      const idx = parts.findIndex(p => p.toLowerCase() === "collection");
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1].trim();
    }
  } catch {
    // ignore
  }

  return null;
}

function mkAssetUrl(chain, contract, tokenId) {
  const c = chainNorm(chain);
  const addr = lower(contract);
  const tid = s(tokenId);
  if (c === "base") return `https://opensea.io/assets/base/${addr}/${tid}`;
  if (c === "eth" || c === "ethereum") return `https://opensea.io/assets/ethereum/${addr}/${tid}`;
  return `https://opensea.io/assets/${addr}/${tid}`;
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

function normalizeTraitsAnyFormat(traitsRaw) {
  const traits = {};

  // v1 array attributes style
  if (Array.isArray(traitsRaw)) {
    for (const t of traitsRaw) {
      const k = s(t?.trait_type || t?.type || t?.key);
      const v = s(t?.value);
      if (!k || !v) continue;
      if (!traits[k]) traits[k] = [];
      traits[k].push(v);
    }
    return traits;
  }

  // object map style
  if (traitsRaw && typeof traitsRaw === "object") {
    for (const [k0, v0] of Object.entries(traitsRaw)) {
      const k = s(k0);
      if (!k) continue;
      const arr = Array.isArray(v0) ? v0 : [v0];
      for (const vv of arr) {
        const v = s(vv);
        if (!v) continue;
        if (!traits[k]) traits[k] = [];
        traits[k].push(v);
      }
    }
    return traits;
  }

  return traits;
}

/**
 * Try OpenSea v2 events endpoint (slug-based).
 * NOTE: endpoint and response shapes may vary; we parse defensively.
 */
async function fetchV2BySlug({ chain, contract, slug, limit }) {
  const c = chainNorm(chain);
  const addr = lower(contract);
  const lim = Math.min(50, Math.max(1, Number(limit) || 25));

  // Candidate endpoints (OpenSea has shifted v2 surface over time)
  const candidates = [
    // events feed (collection)
    `${osBase()}/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=listing&limit=${encodeURIComponent(String(lim))}`,
    `${osBase()}/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=created&limit=${encodeURIComponent(String(lim))}`,
    // some deployments use "listings" explicitly
    `${osBase()}/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=listing_created&limit=${encodeURIComponent(String(lim))}`,
  ];

  let lastErr = null;

  for (const url of candidates) {
    if (debugOn()) console.log(`[LURKER][opensea:v2] url=${url}`);

    try {
      const txt = await fetchTextRetry(url, { headers: osHeaders() });
      const data = tryJson(txt);

      if (!data) throw new Error(`OpenSea v2 non-JSON response: ${txt.slice(0, 120)}`);

      // Common shapes: { events: [...] } or { asset_events: [...] }
      const events = Array.isArray(data?.events) ? data.events
        : Array.isArray(data?.asset_events) ? data.asset_events
        : Array.isArray(data?.assetEvents) ? data.assetEvents
        : [];

      if (debugOn() && !events.length) {
        const keys = Object.keys(data || {}).slice(0, 20);
        console.log(`[LURKER][opensea:v2] no events found. keys=${keys.join(",")}`);
      }

      const listings = events.map((ev) => {
        // Try to find tokenId + contract
        const nft = ev?.nft || ev?.asset || ev?.item || ev?.token || null;

        const tokenId =
          s(nft?.identifier) ||
          s(nft?.token_id) ||
          s(nft?.tokenId) ||
          s(ev?.token_id) ||
          s(ev?.tokenId);

        const cAddr =
          lower(nft?.contract) ||
          lower(nft?.contract_address) ||
          lower(nft?.asset_contract_address) ||
          addr;

        if (!tokenId || !cAddr) return null;

        const listingId =
          s(ev?.id) ||
          s(ev?.event_id) ||
          s(ev?.order_hash) ||
          s(ev?.order?.order_hash) ||
          s(ev?.order?.hash) ||
          `${cAddr}:${tokenId}:${s(ev?.event_timestamp || ev?.created_date || ev?.created_at)}`;

        // Price parsing varies wildly; best-effort
        let priceNative = null;
        let priceCurrency = null;

        const payment = ev?.payment || ev?.payment_token || ev?.paymentToken || null;
        if (payment) {
          priceCurrency = s(payment?.symbol) || null;

          // quantity could be wei
          const q =
            s(payment?.quantity) ||
            s(payment?.amount) ||
            s(ev?.quantity) ||
            s(ev?.total_price) ||
            s(ev?.starting_price);

          if (q) priceNative = weiToEthStr(q) || q;
        } else {
          // older style
          const q = s(ev?.total_price || ev?.starting_price || "");
          if (q) priceNative = weiToEthStr(q) || q;
        }

        const image = s(nft?.image_url || nft?.image || nft?.imageUrl || "");
        const name = s(nft?.name || ev?.item?.name || "");
        const openseaUrl = s(nft?.permalink || ev?.permalink || "") || mkAssetUrl(c, cAddr, tokenId);

        const traits = normalizeTraitsAnyFormat(nft?.traits || nft?.attributes || ev?.traits);

        const seller = s(ev?.seller || ev?.maker || ev?.from_account?.address || ev?.seller?.address || "");

        return {
          source: "opensea_v2",
          chain: c,
          contract: lower(cAddr),
          listingId,
          tokenId,
          name: name || null,
          image: image || null,
          openseaUrl: openseaUrl || null,
          seller: seller || null,
          rarityRank: null,
          rarityScore: null,
          traits,
          priceNative: priceNative != null ? String(priceNative) : null,
          priceCurrency: priceCurrency || (c === "base" ? "ETH" : "ETH"),
          createdAt: s(ev?.event_timestamp || ev?.created_date || ev?.created_at) || null,
          raw: ev,
        };
      }).filter(Boolean);

      // If we got anything, return
      return { listings };
    } catch (e) {
      lastErr = e;
      if (debugOn()) console.log(`[LURKER][opensea:v2] fail: ${e?.message || e}`);
      // try next candidate
    }
  }

  throw lastErr || new Error("OpenSea v2 fetch failed");
}

/**
 * Old v1 events endpoint (contract-based).
 * This is kept as fallback only.
 */
async function fetchV1ByContract({ chain, contract, limit }) {
  const c = chainNorm(chain);
  const contractL = lower(contract);

  const qs = [];
  qs.push(`event_type=created`);
  qs.push(`asset_contract_address=${encodeURIComponent(contractL)}`);
  qs.push(`only_opensea=false`);
  qs.push(`offset=0`);
  qs.push(`limit=${encodeURIComponent(String(Math.min(50, Math.max(1, Number(limit) || 25))))}`);

  const url = `${osBase()}/api/v1/events?${qs.join("&")}`;
  if (debugOn()) console.log(`[LURKER][opensea:v1] url=${url}`);

  const txt = await fetchTextRetry(url, { headers: osHeaders() });
  const data = tryJson(txt);
  if (!data) throw new Error(`OpenSea v1 non-JSON response: ${txt.slice(0, 120)}`);

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
    const currency = s(payment?.symbol) || (c === "base" ? "ETH" : "ETH");

    const image = s(asset?.image_url || asset?.image_preview_url || asset?.image_thumbnail_url);
    const name = s(asset?.name);
    const openseaUrl = s(asset?.permalink) || mkAssetUrl(c, contractL, tokenId);

    let traits = {};
    if (asset?.traits && typeof asset.traits === "object" && !Array.isArray(asset.traits)) {
      traits = normalizeTraitsAnyFormat(asset.traits);
    } else if (Array.isArray(asset?.traits)) {
      traits = normalizeTraitsAnyFormat(asset.traits);
    }

    const seller = s(ev?.seller?.address || ev?.from_account?.address);

    return {
      source: "opensea_v1",
      chain: c,
      contract: contractL,
      listingId,
      tokenId,
      name: name || null,
      image: image || null,
      openseaUrl: openseaUrl || null,
      seller: seller || null,
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

async function fetchListings({ chain, contract, limit = 20, osSlugOrUrl = null }) {
  const c = chainNorm(chain);
  const addr = lower(contract);

  const slug = extractSlug(osSlugOrUrl);

  // Prefer v2 if slug exists
  if (slug) {
    try {
      return await fetchV2BySlug({ chain: c, contract: addr, slug, limit });
    } catch (e) {
      console.log(`[LURKER][opensea] v2 failed for slug=${slug}: ${e?.message || e}`);
      // fallback to v1 contract endpoint
    }
  }

  return await fetchV1ByContract({ chain: c, contract: addr, limit });
}

module.exports = { fetchListings };

