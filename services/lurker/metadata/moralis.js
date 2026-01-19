// services/lurker/metadata/moralis.js
// ======================================================
// LURKER: Moralis metadata + traits fetcher
// - Fetch token metadata (name/image/attributes)
// - Fetch collection NFTs for rarity builder (paginated)
// - Fetch wallet's tokenIds for a specific contract (for ApprovalForAll listing radar)
//
// ENV:
//   MORALIS_API_KEY=...
// ======================================================

const fetch = require("node-fetch");

function s(v) { return String(v || "").trim(); }
function chainNorm(v) { return s(v).toLowerCase(); }
function debugOn() { return String(process.env.LURKER_DEBUG || "0").trim() === "1"; }

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

function parseTraitsFromMetadata(md) {
  // md may be object, or stringified json
  let meta = md;
  if (typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  if (!meta || typeof meta !== "object") return { name: null, image: null, traits: {} };

  const name = s(meta?.name);
  const image = s(meta?.image || meta?.image_url || meta?.imageUrl);

  const attrs = Array.isArray(meta?.attributes) ? meta.attributes
    : Array.isArray(meta?.traits) ? meta.traits
    : [];

  const traits = {};
  for (const a of attrs) {
    const k = s(a?.trait_type || a?.key || a?.type);
    const v = s(a?.value);
    if (!k || !v) continue;
    if (!traits[k]) traits[k] = [];
    traits[k].push(v);
  }

  return { name: name || null, image: image || null, traits };
}

async function fetchTokenMetadata({ chain, contract, tokenId }) {
  const c = moralisChain(chain);
  const addr = s(contract).toLowerCase();
  const tid = s(tokenId);

  const url = `${moralisBase()}/nft/${addr}/${encodeURIComponent(tid)}?chain=${encodeURIComponent(c)}&format=decimal&normalizeMetadata=true`;

  if (debugOn()) console.log(`[LURKER][moralis] token url=${url}`);

  const res = await fetch(url, { headers: moralisHeaders(), timeout: 20000 });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Moralis ${res.status}: ${txt.slice(0, 220)}`);
  }

  const data = await res.json();
  // fields vary; prefer normalized_metadata when present
  const md = data?.normalized_metadata ?? data?.metadata ?? null;
  const out = parseTraitsFromMetadata(md);

  // Some responses include media/image separately
  const fallbackImg = s(data?.media?.original_media_url || data?.media?.media_collection?.high?.url || "");
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

  const res = await fetch(url, { headers: moralisHeaders(), timeout: 25000 });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Moralis ${res.status}: ${txt.slice(0, 220)}`);
  }

  const data = await res.json();
  const result = Array.isArray(data?.result) ? data.result : [];
  const next = data?.cursor ? String(data.cursor) : null;

  const tokens = result.map(r => {
    const tokenId = s(r?.token_id);
    const md = r?.normalized_metadata ?? r?.metadata ?? null;
    const parsed = parseTraitsFromMetadata(md);
    return {
      tokenId,
      traits: parsed.traits || {},
      name: parsed.name || null,
      image: parsed.image || null,
    };
  }).filter(t => t.tokenId);

  return { tokens, cursor: next };
}

/**
 * Fetch token IDs owned by a wallet for a given contract.
 * Used by ApprovalForAll listing radar to produce tokenIds for rarity filtering.
 *
 * ENV knobs:
 *   LURKER_APPROVAL_WALLET_PAGE_LIMIT=100
 *   LURKER_APPROVAL_WALLET_PAGES_MAX=2
 */
async function fetchWalletContractTokenIds({ chain, wallet, contract }) {
  const c = moralisChain(chain);
  const w = s(wallet).toLowerCase();
  const addr = s(contract).toLowerCase();

  const pageLimit = Math.min(100, Math.max(1, Number(process.env.LURKER_APPROVAL_WALLET_PAGE_LIMIT || 100)));
  const pagesMax = Math.min(5, Math.max(1, Number(process.env.LURKER_APPROVAL_WALLET_PAGES_MAX || 2)));

  let cursor = null;
  const out = [];

  for (let i = 0; i < pagesMax; i++) {
    const qs = [];
    qs.push(`chain=${encodeURIComponent(c)}`);
    qs.push(`format=decimal`);
    qs.push(`limit=${encodeURIComponent(String(pageLimit))}`);
    qs.push(`token_addresses=${encodeURIComponent(addr)}`); // filter to this collection
    if (cursor) qs.push(`cursor=${encodeURIComponent(cursor)}`);

    const url = `${moralisBase()}/${w}/nft?${qs.join("&")}`;

    if (debugOn()) console.log(`[LURKER][moralis] walletNFT url=${url}`);

    const res = await fetch(url, { headers: moralisHeaders(), timeout: 25000 });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Moralis ${res.status}: ${txt.slice(0, 220)}`);
    }

    const data = await res.json();
    const result = Array.isArray(data?.result) ? data.result : [];
    for (const r of result) {
      const tokenId = s(r?.token_id);
      if (tokenId) out.push(tokenId);
    }

    cursor = data?.cursor ? String(data.cursor) : null;
    if (!cursor) break;
  }

  // de-dupe
  const uniq = Array.from(new Set(out));
  return uniq;
}

module.exports = { fetchTokenMetadata, fetchCollectionPage, fetchWalletContractTokenIds };
