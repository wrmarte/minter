const { Contract } = require('ethers');
const fetch = require('node-fetch');
const { getProvider } = require('../services/provider');  // ✅ make sure it's correct path for your structure

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)'
];

// Helper to sanitize IPFS links
function fixIpfs(url) {
  if (!url) return null;
  return url.startsWith('ipfs://')
    ? url.replace('ipfs://', 'https://ipfs.io/ipfs/')
    : url;
}

async function fetchMetadata(contractAddress, tokenId, chain = 'base') {
  // ✅ Always sanitize chain lowercase
  chain = chain.toLowerCase();

  try {
    const provider = getProvider(chain);
    const contract = new Contract(contractAddress, abi, provider);
    const tokenURI = await contract.tokenURI(tokenId);
    const metadataUrl = fixIpfs(tokenURI);

    if (!metadataUrl) throw new Error('Empty tokenURI returned');

    const response = await fetch(metadataUrl);
    const metadata = await response.json();
    if (metadata) return metadata;
  } catch (err) {
    console.warn(`⚠️ tokenURI fetch failed on ${chain}: ${err.message}`);
  }

  // ✅ ETH-specific fallbacks (Reservoir -> Moralis)
  if (chain === 'eth') {
    // ✅ First: Reservoir fallback
    try {
      const reservoirUrl = `https://api.reservoir.tools/tokens/v6?tokens=${contractAddress}:${tokenId}`;
      const headers = { 'x-api-key': process.env.RESERVOIR_API_KEY };

      const res = await fetch(reservoirUrl, { headers });
      const data = await res.json();

      const token = data?.tokens?.[0]?.token;
      if (token?.image) {
        return {
          image: token.image,
          attributes: token.attributes || []
        };
      }
    } catch (err) {
      console.warn(`⚠️ Reservoir fallback failed: ${err.message}`);
    }

    // ✅ Second: Moralis fallback
    try {
      const moralisUrl = `https://deep-index.moralis.io/api/v2.2/nft/${contractAddress}/${tokenId}?chain=eth&format=decimal`;
      const headers = { 'X-API-Key': process.env.MORALIS_API_KEY };

      const moralisRes = await fetch(moralisUrl, { headers });
      const moralisData = await moralisRes.json();

      const raw = moralisData?.metadata ? JSON.parse(moralisData.metadata) : {};
      if (raw?.image) {
        return {
          image: fixIpfs(raw.image),
          attributes: raw.attributes || []
        };
      }
    } catch (err) {
      console.warn(`⚠️ Moralis fallback failed: ${err.message}`);
    }
  }

  console.warn('⚠️ Metadata fully unavailable after all fallback attempts');
  return {};
}

module.exports = { fetchMetadata };

