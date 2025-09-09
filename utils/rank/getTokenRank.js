// utils/rank/getTokenRank.js
const fetch = require('node-fetch');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const rarityCache = new Map(); // key: `${chain}:${contract}` -> { ts, tokenToRank: Map<string,number>, totalSupply:number|null }

function now() { return Date.now(); }
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
function toBigIntSafe(x) { try { return BigInt(String(x)); } catch { return 0n; } }

module.exports = { getTokenRank };

/**
 * Main: returns { rank:number|null, totalSupply:number|null, source:'reservoir'|'opensea'|'local'|'local-cache'|'none' }
 */
async function getTokenRank({ chain, contract, tokenId }) {
  const chainKey = toReservoirChain(chain);
  const tokenIdStr = String(tokenId);
  const cc = String(contract).toLowerCase();

  // Fast path: provider rarity if available
  const provider = await fetchRankFromProviders({ chain, chainKey, contract: cc, tokenId: tokenIdStr }).catch(() => null);
  if (provider?.rank != null) return provider;

  // Local rank (cached or compute)
  const local = await getLocalRank({ chainKey, contract: cc, tokenId: tokenIdStr }).catch(() => null);
  if (local?.rank != null) return local;

  return { rank: null, totalSupply: local?.totalSupply ?? null, source: 'none' };
}

/* ========================= Provider rank ========================= */

async function fetchRankFromProviders({ chain, chainKey, contract, tokenId }) {
  const resv = await fetchRankReservoir({ chainKey, contract, tokenId }).catch(() => null);
  if (resv?.rank != null) return resv;

  const osKey = process.env.OPENSEA_API_KEY;
  if (osKey && (chain === 'base' || chain === 'eth' || chain === 'ethereum')) {
    const os = await fetchRankOpenSea({ chain, contract, tokenId, apiKey: osKey }).catch(() => null);
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
  const rank = t?.rarityRank ?? t?.rarity?.rank ?? null;

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
  const rank = nft?.rarity?.rank ?? nft?.rarity_rank ?? null;

  const totalSupply = nft?.collection?.total_supply ? Number(nft.collection.total_supply) : null;
  return { rank: rank != null ? Number(rank) : null, totalSupply, source: 'opensea' };
}

/* ========================= Local rank (fallback) ========================= */

async function getLocalRank({ chainKey, contract, tokenId }) {
  const cacheKey = `${chainKey}:${contract}`;
  const c = rarityCache.get(cacheKey);
  if (c && (now() - c.ts) < CACHE_TTL_MS) {
    return { rank: c.tokenToRank.get(tokenId) ?? null, totalSupply: c.totalSupply ?? null, source: 'local-cache' };
  }
  if (!chainKey) return { rank: null, totalSupply: null, source: 'local' };

  const headers = baseHeaders(chainKey);

  // 1) Total supply
  const { totalSupply } = await fetchCollectionStats({ chainKey, contract, headers }).catch(() => ({ totalSupply: null }));

  // 2) Pull ALL tokens’ attributes. Try collection= first; if empty, try contracts=
  let tokens = await fetchAllTokensWithAttributes({ headers, contract, useCollectionParam: true }).catch(() => []);
  if (!tokens.length) tokens = await fetchAllTokensWithAttributes({ headers, contract, useCollectionParam: false }).catch(() => []);

  if (!tokens.length) {
    // nothing to rank
    return { rank: null, totalSupply, source: 'local' };
  }

  // 3) Build frequency map if tokenCount missing
  // Structure we want per attribute: (key,value) -> frequency count
  const freq = new Map(); // "key::value" -> count
  let anyTokenCountPresent = false;

  for (const t of tokens) {
    const attrs = Array.isArray(t.attributes) ? t.attributes : [];
    for (const a of attrs) {
      if (a && (a.tokenCount != null || a.count != null)) anyTokenCountPresent = true;
    }
  }

  if (!anyTokenCountPresent) {
    for (const t of tokens) {
      const attrs = Array.isArray(t.attributes) ? t.attributes : [];
      for (const a of attrs) {
        const k = sanitizeAttrKey(a?.key ?? a?.trait_type);
        const v = sanitizeAttrVal(a?.value);
        if (!k || v == null) continue;
        const key = `${k}::${v}`;
        freq.set(key, (freq.get(key) || 0) + 1);
      }
    }
  }

  // 4) Compute score per token: sum log(total/attrCount); fall back to freq map if tokenCount missing
  const ts = Number(totalSupply) || guessTotalSupply(tokens);
  const scores = new Map(); // tokenId -> score
  for (const t of tokens) {
    const attrs = Array.isArray(t.attributes) ? t.attributes : [];
    let score = 0;
    for (const a of attrs) {
      let count = Number(a?.tokenCount ?? a?.count ?? 0);
      if (!count && !anyTokenCountPresent) {
        const k = sanitizeAttrKey(a?.key ?? a?.trait_type);
        const v = sanitizeAttrVal(a?.value);
        if (!k || v == null) continue;
        const key = `${k}::${v}`;
        count = Number(freq.get(key) || 0);
      }
      if (!count || !Number.isFinite(count)) continue;
      score += Math.log(ts / count);
    }
    scores.set(String(t.tokenId), score);
  }

  // 5) Rank: higher score = rarer; tie-break on numeric tokenId asc
  const list = Array.from(scores.entries()); // [tokenId, score]
  list.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const ai = toBigIntSafe(a[0]), bi = toBigIntSafe(b[0]);
    if (ai < bi) return -1; if (ai > bi) return 1; return 0;
  });

  const tokenToRank = new Map();
  for (let i = 0; i < list.length; i++) tokenToRank.set(list[i][0], i + 1);

  rarityCache.set(cacheKey, { ts: now(), tokenToRank, totalSupply: ts });
  return { rank: tokenToRank.get(tokenId) ?? null, totalSupply: ts, source: 'local' };
}

/* ========================= Reservoir helpers ========================= */

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
 * Pulls all tokens with attributes.
 *  - If useCollectionParam = true: ?collection=<contract>
 *  - Else: ?contracts=<contract>
 * Returns [{ tokenId, attributes }]
 */
async function fetchAllTokensWithAttributes({ headers, contract, useCollectionParam }) {
  const out = [];
  let continuation = null;
  let safety = 300; // up to 300k tokens @ 1000/page

  do {
    const url = new URL('https://api.reservoir.tools/tokens/v7');
    if (useCollectionParam) url.searchParams.append('collection', contract);
    else url.searchParams.append('contracts', contract);
    url.searchParams.set('includeAttributes', 'true');
    url.searchParams.set('limit', '1000');
    if (continuation) url.searchParams.set('continuation', continuation);

    const r = await fetch(url.toString(), { headers });
    if (!r.ok) break;
    const j = await r.json().catch(() => null);
    const tokens = j?.tokens || [];
    continuation = j?.continuation || null;

    for (const row of tokens) {
      const tok = row?.token || {};
      const tokenId = String(tok.tokenId ?? tok.id ?? '');
      if (!tokenId) continue;
      // Normalize attribute shape: prefer {key, value, tokenCount}
      const attrs = Array.isArray(tok.attributes)
        ? tok.attributes.map(a => ({
            key: a?.key ?? a?.trait_type ?? null,
            value: a?.value ?? a?.trait_value ?? null,
            tokenCount: a?.tokenCount ?? a?.count ?? null
          }))
        : [];
      out.push({ tokenId, attributes: attrs });
    }
  } while (continuation && safety-- > 0);

  return out;
}

/* ========================= Local helpers ========================= */

function guessTotalSupply(tokens) {
  const s = new Set(tokens.map(t => String(t.tokenId)));
  return s.size || tokens.length || 1;
}
function sanitizeAttrKey(k) {
  if (k == null) return null;
  const s = String(k).trim();
  return s ? s : null;
}
function sanitizeAttrVal(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

