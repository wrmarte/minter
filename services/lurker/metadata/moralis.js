// services/lurker/metadata/moralis.js
// ======================================================
// LURKER: Moralis metadata + traits fetcher
// - Fetch token metadata (name/image/attributes)
// - Fetch collection NFTs for rarity builder (paginated)
//
// ENV:
//   MORALIS_API_KEY=...
//
// OPTIONAL:
//   MORALIS_TIMEOUT_MS=30000
//   MORALIS_RETRIES=2
//   MORALIS_RETRY_BASE_MS=800
//   MORALIS_IPFS_GATEWAY=https://ipfs.io/ipfs/   (or your preferred gateway)
// ======================================================

let fetchFn = null;
try {
  fetchFn = global.fetch ? global.fetch.bind(global) : require("node-fetch");
} catch {
  fetchFn = require("node-fetch");
}

function s(v) { return String(v || "").trim(); }
function chainNorm(v) { return s(v).toLowerCase(); }
function debugOn() { return String(process.env.LURKER_DEBUG || "0").trim() === "1"; }

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

function moralisBase() {
  // Moralis commonly exposes v2.2
  return "https://deep-index.moralis.io/api/v2.2";
}

function moralisHeaders() {
  const key = s(process.env.MORALIS_API_KEY);
  if (!key) throw new Error("MORALIS_API_KEY missing");
  return { accept: "application/json", "X-API-Key": key };
}

function moralisChain(chain) {
  const c = chainNorm(chain);
  if (c === "eth" || c === "ethereum") return "eth";
  if (c === "base") return "base";
  // ApeChain support may not exist on Moralis; keep placeholder
  if (c === "ape" || c === "apechain") return "apechain";
  return c;
}

function ipfsToHttp(u) {
  const url = s(u);
  if (!url) return null;

  // ipfs://CID/... -> gateway/CID/...
  if (url.startsWith("ipfs://")) {
    const gw = s(process.env.MORALIS_IPFS_GATEWAY || "https://ipfs.io/ipfs/").replace(/\/+$/, "") + "/";
    return gw + url.replace("ipfs://", "").replace(/^ipfs\//, "");
  }

  // ipfs://ipfs/CID -> gateway/CID
  if (url.startsWith("ipfs://ipfs/")) {
    const gw = s(process.env.MORALIS_IPFS_GATEWAY || "https://ipfs.io/ipfs/").replace(/\/+$/, "") + "/";
    return gw + url.replace("ipfs://ipfs/", "");
  }

  return url;
}

// Pull traits from multiple common schemas
function parseTraitsFromMetadata(md) {
  let meta = md;

  // md may be object, or stringified json
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }

  if (!meta || typeof meta !== "object") return { name: null, image: null, traits: {} };

  const name = s(meta?.name);

  // image field variants
  const imageRaw =
    meta?.image ||
    meta?.image_url ||
    meta?.imageUrl ||
    meta?.imageURI ||
    meta?.image_uri ||
    null;

  const image = ipfsToHttp(imageRaw);

  // attributes variants:
  // - attributes: [{trait_type,value}]
  // - traits: [{trait_type,value}] or object
  // - properties: { ... }
  let attrs = [];

  if (Array.isArray(meta?.attributes)) attrs = meta.attributes;
  else if (Array.isArray(meta?.traits)) attrs = meta.traits;
  else if (Array.isArray(meta?.properties)) attrs = meta.properties;

  const traits = {};

  // object-based traits: { "Hat": "Crown" } or { "Hat": ["Crown"] }
  if (!attrs.length && meta?.traits && typeof meta.traits === "object" && !Array.isArray(meta.traits)) {
    for (const [kRaw, vRaw] of Object.entries(meta.traits)) {
      const k = s(kRaw);
      if (!k) continue;
      const arr = Array.isArray(vRaw) ? vRaw : [vRaw];
      for (const v of arr) {
        const vv = s(v);
        if (!vv) continue;
        if (!traits[k]) traits[k] = [];
        traits[k].push(vv);
      }
    }
  }

  // properties object
  if (meta?.properties && typeof meta.properties === "object" && !Array.isArray(meta.properties)) {
    for (const [kRaw, vRaw] of Object.entries(meta.properties)) {
      const k = s(kRaw);
      if (!k) continue;
      const vv = s(vRaw?.value ?? vRaw);
      if (!vv) continue;
      if (!traits[k]) traits[k] = [];
      traits[k].push(vv);
    }
  }

  // array-based attributes
  for (const a of attrs) {
    const k = s(a?.trait_type || a?.key || a?.type || a?.name);
    const v = s(a?.value);
    if (!k || !v) continue;
    if (!traits[k]) traits[k] = [];
    traits[k].push(v);
  }

  return { name: name || null, image: image || null, traits };
}

async function fetchWithAbort(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonRetry(url, opts = {}) {
  const timeoutMs = Math.max(8000, num(process.env.MORALIS_TIMEOUT_MS, 30000));
  const retries = Math.max(1, Math.min(6, num(process.env.MORALIS_RETRIES, 2)));
  const baseBackoff = Math.max(250, num(process.env.MORALIS_RETRY_BASE_MS, 800));

  let lastErr = null;

  for (let i = 0; i < retries; i++) {
    try {
      const attemptTimeout = Math.min(90000, timeoutMs + i * 10000);
      const res = await fetchWithAbort(url, opts, attemptTimeout);

      if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
        const ra = s(res.headers.get("retry-after"));
        const waitMs = ra
          ? Math.min(45000, Math.max(1000, Math.floor(Number(ra) * 1000)))
          : jitter(baseBackoff * Math.pow(2, i));
        const txt = await res.text().catch(() => "");
        throw new Error(`Moralis ${res.status} (retry in ${waitMs}ms): ${txt.slice(0, 200)}`);
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Moralis ${res.status}: ${txt.slice(0, 220)}`);
      }

      return await res.json();
    } catch (e) {
      lastErr = e;

      const waitMs = jitter(baseBackoff * Math.pow(2, i));
      if (debugOn()) {
        const tag = isAbortErr(e) ? "abort/timeout" : "err";
        console.log(`[LURKER][moralis] retry ${i + 1}/${retries} in ${waitMs}ms — (${tag}) ${e?.message || e}`);
      }

      if (i < retries - 1) await sleep(waitMs);
    }
  }

  throw lastErr || new Error("Moralis fetch failed");
}

async function fetchTokenMetadata({ chain, contract, tokenId }) {
  const c = moralisChain(chain);
  const addr = s(contract).toLowerCase();
  const tid = s(tokenId);

  const url = `${moralisBase()}/nft/${addr}/${encodeURIComponent(tid)}?chain=${encodeURIComponent(c)}&format=decimal&normalizeMetadata=true`;

  if (debugOn()) console.log(`[LURKER][moralis] token url=${url}`);

  const data = await fetchJsonRetry(url, { headers: moralisHeaders() });

  // fields vary; prefer normalized_metadata when present
  const md = data?.normalized_metadata ?? data?.metadata ?? null;
  const out = parseTraitsFromMetadata(md);

  // Some responses include media/image separately
  const fallbackImg = ipfsToHttp(
    data?.media?.original_media_url ||
    data?.media?.media_collection?.high?.url ||
    data?.image ||
    data?.image_url ||
    ""
  );
  if (!out.image && fallbackImg) out.image = fallbackImg;

  const fallbackName = s(data?.name || "");
  if (!out.name && fallbackName) out.name = fallbackName;

  return out; // {name,image,traits}
}

async function fetchCollectionPage({ chain, contract, limit = 100, cursor = null }) {
  const c = moralisChain(chain);
  const addr = s(contract).toLowerCase();

  const qs = [];
  qs.push(`chain=${encodeURIComponent(c)}`);
  qs.push(`format=decimal`);
  qs.push(`normalizeMetadata=true`);
  qs.push(`limit=${encodeURIComponent(String(Math.min(100, Math.max(1, limit))))}`);
  if (cursor) qs.push(`cursor=${encodeURIComponent(cursor)}`);

  const url = `${moralisBase()}/nft/${addr}?${qs.join("&")}`;

  if (debugOn()) console.log(`[LURKER][moralis] collection url=${url}`);

  const data = await fetchJsonRetry(url, { headers: moralisHeaders() });

  const result = Array.isArray(data?.result) ? data.result : [];
  const next = data?.cursor ? String(data.cursor) : null;

  const tokens = result.map(r => {
    const tokenId = s(r?.token_id);

    // fields vary; prefer normalized_metadata when present
    const md = r?.normalized_metadata ?? r?.metadata ?? null;
    const parsed = parseTraitsFromMetadata(md);

    // sometimes Moralis puts image/name on root
    const fallbackImg = ipfsToHttp(r?.media?.original_media_url || r?.image || r?.image_url || "");
    const fallbackName = s(r?.name || "");

    return {
      tokenId,
      traits: parsed.traits || {},
      name: parsed.name || fallbackName || null,
      image: parsed.image || fallbackImg || null,
    };
  }).filter(t => t.tokenId);

  return { tokens, cursor: next };
}

module.exports = { fetchTokenMetadata, fetchCollectionPage };

