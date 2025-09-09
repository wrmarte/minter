// utils/rank/getTokenRank.js
const fetch = require('node-fetch');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const rarityCache = new Map(); // key: `${chain}:${contract}` -> { ts, tokenToRank: Map, totalSupply }

/**
 * Main entry: get rank for one token. Tries provider rank, otherwise computes locally.
 * Returns: { rank: number|null, totalSupply: number|null, source: string }
 */
async function getTokenRank({ chain, contract, tokenId }) {
  const chainKey = toReservoirChain(chain); // 'base' | 'ethereum' | null
  const tokenIdStr = String(tokenId);

  // 1) Provider rank (fast path)
  const fromProvider = await fetchRankFromProviders({ chain, chainKey, contract, tokenId: tokenIdStr });
  if (fromProvider?.rank != null) return fromProvider;

  // 2) Local rank (fallback)
  const local = await getLocalRank({ chain, chainKey, contract, tokenId: tokenIdStr });
  if (local?.rank != null) return local;

  return { rank: null, totalSupply: local?.totalSupply ?? null, source: 'none' };
}

/* ---------------- Provider rank (Reservoir primary, OpenSea optional) ---------------- */

async function fetchRankFromProviders({ chain, chainKey, contract, tokenId }) {
  // Reservoir first
  const resv = await fetchRankReservoir({ chainKey, contract, tokenId }).catch(() => null);
  if (resv?.rank != null) return resv;

  // Optional OpenSea fallback (only if API key present)
  const oseakey = process.env.OPENSEA_API_KEY;
  if (oseakey && (chain === 'base' || chain === 'eth' || chain === 'ethereum')) {
    const os = await fetchRankOpenSea({ chain, contract, tokenId, apiKey: oseakey }).catch(() => null);
    if (os?.rank != null) return os;
  }
  return null;
}

async function fetchRankReservoir({ chainKey, contract, tokenId }) {
  if (!chainKey) return null;
  const headers = baseHeaders(chainKey);

  const url = new URL('https://api.reservoir.tools/tokens/v7');
  url.searchParams.append('tokens', `${contract}:${tokenId}`);
  url.searchParams.set('includeAttributes', 'true');

  const r = await fetch(url.toString(), { headers });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const t = j?.tokens?.[0]?.token;
  const rank =
    t?.rarityRank ??
    t?.rarity?.rank ??
    null;

  // totalSupply (nice for UI)
  const { totalSupply } = await fetchCollectionStats({ chainKey, contract }).catch(() => ({ totalSupply: null }));
  return { rank: rank != null ? Number(rank) : null, totalSupply, source: 'reservoir' };
}

async function fetchRankOpenSea({ chain, contract, tokenId, apiKey }) {
  const chainKey = chain === 'base' ? 'base' : (chain === 'eth' || chain === 'ethereum') ? 'ethereum' : null;
  if (!chainKey) return null;

  const url = `https://api.opensea.io/api/v2/chain/${chainKey}/contract/${contract}/nfts/${tokenId}`;
  const r = await fetch(url, { headers: { 'accept': 'application/json', 'x-api-key': apiKey } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const nft = j?.nft;
  const rank =
    nft?.rarity?.rank ??
    nft?.rarity_rank ??
    null;

  const totalSupply = nft?.collection?.total_supply ? Number(nft.collection.total_supply) : null;
  return { rank: rank != null ? Number(rank) : null, totalSupply, source: 'opensea' };
}

/* ---------------- Local rank fallback (compute from trait frequencies) ---------------- */

async function getLocalRank({ chain, chainKey, contract, tokenId }) {
  const cacheKey = `${(chain || '').toLowerCase()}:${contract.toLowerCase()}`;
  const now = Date.now();

  // Use cached ranks if fresh
  const cached = rarityCache.get(cacheKey);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) {
    const rank = cached.tokenToRank.get(tokenId) ?? null;
    return { rank, totalSupply: cached.totalSupply ?? null, source: 'local-cache' };
  }

  if (!chainKey) return { rank: null, totalSupply: null, source: 'local' };
  const headers = baseHeaders(chainKey);

  // 1) Collection stats (total supply)
  const { totalSupply } = await fetchCollectionStats({ chainKey, contract, headers }).catch(() => ({ totalSupply: null }));

  // 2) Page through all tokens, gather per-token attributes and tokenCount (frequency)
  const tokens = await fetchAllTokensWithAttributes({ contract, headers }).catch(() => []);
  if (!tokens.length) {
    return { rank: null, totalSupply, source: 'local' };
  }

  // 3) Compute rarity score per token using tokenCount from attributes
  // Score = sum over traits of log(totalSupply / tokenCount)   (higher is rarer)
  const ts = Number(totalSupply) || guessTotalSupply(tokens);
  const scores = new Map(); // tokenId -> score
  for (const t of tokens) {
    const attrs = Array.isArray(t.attributes) ? t.attributes : [];
    let score = 0;
    for (const a of attrs) {
      const count = Number(a?.tokenCount || a?.count || 0);
      if (!count || !Number.isFinite(count)) continue;
      const freq = count / ts;
      if (freq > 0) score += Math.log(ts / count);
    }
    scores.set(String(t.tokenId), score);
  }

  // 4) Rank by score desc (break ties by numeric tokenId asc)
  const arr = Array.from(scores.entries()); // [tokenId, score][]
  arr.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    // tie-break: numeric tokenId ascending
    const ai = toBigIntSafe(a[0]);
    const bi = toBigIntSafe(b[0]);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  });

  const tokenToRank = new Map();
  for (let i = 0; i < arr.length; i++) tokenToRank.set(arr[i][0], i + 1);

  // Cache
  rarityCache.set(cacheKey, { ts: now, tokenToRank, totalSupply: ts });

  return { rank: tokenToRank.get(tokenId) ?? null, totalSupply: ts, source: 'local' };
}

/* ---------------- Helpers ---------------- */

function toReservoirChain(chain) {
  const c = (chain || '').toLowerCase();
  if (c === 'base') return 'base';
  if (c === 'eth' || c === 'ethereum') return 'ethereum';
  return null;
}
function baseHeaders(chainKey) {
  const h = { 'Content-Type': 'application/json', 'x-reservoir-chain': chainKey };
  if (process.env.RESERVOIR_API_KEY) h['x-api-key'] = process.env.RESERVOIR_API_KEY;
  return h;
}

async function fetchCollectionStats({ chainKey, contract, headers }) {
  const h = headers || baseHeaders(chainKey);
  const url = new URL('https://api.reservoir.tools/collections/v7');
  url.searchParams.append('contract', contract);
  const r = await fetch(url.toString(), { headers: h });
  if (!r.ok) return { totalSupply: null };
  const j = await r.json().catch(() => null);
  const c = j?.collections?.[0];
  const totalSupply = c?.tokenCount ? Number(c.tokenCount) : null;
  return { totalSupply };
}

/**
 * Fetch all tokens in a collection with attributes (paged).
 * Returns array: [{ tokenId, attributes }]
 */
async function fetchAllTokensWithAttributes({ contract, headers }) {
  const out = [];
  let continuation = null;
  let safety = 200; // up to 200k tokens (1000 per page) — adjust if needed

  do {
    const url = new URL('https://api.reservoir.tools/tokens/v7');
    url.searchParams.append('collection', contract);
    url.searchParams.set('includeAttributes', 'true');
    url.searchParams.set('limit', '1000');
    if (continuation) url.searchParams.set('continuation', continuation);

    const r = await fetch(url.toString(), { headers });
    if (!r.ok) break;
    const j = await r.json().catch(() => null);
    const tokens = j?.tokens || [];
    continuation = j?.continuation || null;

    for (const t of tokens) {
      const tok = t?.token || {};
      const tokenId = String(tok.tokenId || tok.id || '');
      if (!tokenId) continue;
      // attributes usually in tok.attributes as [{key, value, tokenCount}, ...]
      const attributes = Array.isArray(tok.attributes) ? tok.attributes : [];
      out.push({ tokenId, attributes });
    }
  } while (continuation && safety-- > 0);

  return out;
}

function guessTotalSupply(tokens) {
  // Fallback: approximate supply from distinct tokenIds count
  const s = new Set(tokens.map(t => t.tokenId));
  return s.size || tokens.length || 1;
}

function toBigIntSafe(x) {
  try { return BigInt(String(x)); } catch { return 0n; }
}

module.exports = { getTokenRank };

