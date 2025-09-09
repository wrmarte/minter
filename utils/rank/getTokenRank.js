// utils/rank/getTokenRank.js
const fetch = require('node-fetch');

/**
 * Fetch rarity rank for a given NFT (contract + tokenId) with multi-provider fallbacks.
 * Returns: { rank: number|null, totalSupply: number|null, source: string } or null
 *
 * Primary: Reservoir (Base/Ethereum). Make sure to pass the correct chain header.
 * Optional fallbacks: OpenSea (needs OPENSEA_API_KEY; supports some Base collections).
 */
async function getTokenRank({ chain, contract, tokenId }) {
  const chainKey = chain === 'base' ? 'base' : chain === 'eth' ? 'ethereum' : null;

  // --- Try Reservoir first (best coverage + free-ish; API key optional but recommended)
  const resv = await fetchRankReservoir({ chainKey, contract, tokenId }).catch(() => null);
  if (resv && resv.rank) return resv;

  // --- Try OpenSea if API key present and we’re on a supported chain
  const oseakey = process.env.OPENSEA_API_KEY;
  if (oseakey && (chain === 'base' || chain === 'eth')) {
    const os = await fetchRankOpenSea({ chain, contract, tokenId, apiKey: oseakey }).catch(() => null);
    if (os && os.rank) return os;
  }

  // No rank available
  return { rank: null, totalSupply: null, source: 'none' };
}

async function fetchRankReservoir({ chainKey, contract, tokenId }) {
  if (!chainKey) return null;

  const headers = { 'Content-Type': 'application/json', 'x-reservoir-chain': chainKey };
  if (process.env.RESERVOIR_API_KEY) headers['x-api-key'] = process.env.RESERVOIR_API_KEY;

  // 1) Ask for the token; see if rarity is present
  const url = new URL('https://api.reservoir.tools/tokens/v7');
  url.searchParams.append('tokens', `${contract}:${tokenId}`);
  url.searchParams.set('includeAttributes', 'true');

  const tokRes = await fetch(url.toString(), { headers });
  if (!tokRes.ok) return null;
  const tokJson = await tokRes.json().catch(() => null);
  const t = tokJson?.tokens?.[0]?.token;

  let rank =
    t?.rarityRank ??
    t?.rarity?.rank ??
    null;

  // 2) Try to get total supply (nice for UI), but optional
  let totalSupply = null;
  try {
    const cu = new URL('https://api.reservoir.tools/collections/v7');
    cu.searchParams.append('contract', contract);
    const colRes = await fetch(cu.toString(), { headers });
    const colJson = await colRes.json().catch(() => null);
    const c = colJson?.collections?.[0];
    totalSupply = c?.tokenCount ? Number(c.tokenCount) : null;
  } catch {}

  return { rank: rank != null ? Number(rank) : null, totalSupply, source: 'reservoir' };
}

async function fetchRankOpenSea({ chain, contract, tokenId, apiKey }) {
  // OpenSea v2 (optional): Some Base collections expose a rarity object
  const chainKey = chain === 'base' ? 'base' : chain === 'eth' ? 'ethereum' : null;
  if (!chainKey) return null;

  const url = `https://api.opensea.io/api/v2/chain/${chainKey}/contract/${contract}/nfts/${tokenId}`;
  const res = await fetch(url, { headers: { 'accept': 'application/json', 'x-api-key': apiKey } });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  const nft = j?.nft;
  const rank =
    nft?.rarity?.rank ??
    nft?.rarity_rank ??
    null;

  const totalSupply = nft?.collection?.total_supply ? Number(nft.collection.total_supply) : null;
  return { rank: rank != null ? Number(rank) : null, totalSupply, source: 'opensea' };
}

module.exports = { getTokenRank };
