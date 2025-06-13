const { Contract } = require('ethers');
const fetch = require('node-fetch');
const { getProvider } = require('../services/provider');

const abi = ['function tokenURI(uint256 tokenId) view returns (string)'];

function fixIpfs(url) {
  if (!url) return null;
  return url.startsWith('ipfs://') ? url.replace('ipfs://', 'https://ipfs.io/ipfs/') : url;
}

async function safeFetchJson(url) {
  try {
    const res = await fetch(url, { timeout: 6000 });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      console.warn(`❌ Non-JSON content at ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`❌ Failed JSON fetch: ${err.message}`);
    return null;
  }
}

async function fetchMetadata(contractAddress, tokenId, chain = 'base') {
  chain = chain.toLowerCase();

  try {
    const provider = getProvider(chain);
    const contract = new Contract(contractAddress, abi, provider);
    const tokenURI = await contract.tokenURI(tokenId);
    const metadataUrl = fixIpfs(tokenURI);
    if (!metadataUrl) throw new Error('Empty tokenURI');

    const meta = await safeFetchJson(metadataUrl);
    if (meta?.image) return meta;
  } catch (err) {
    console.warn(`⚠️ tokenURI fetch failed on ${chain}: ${err.message}`);
  }

  if (chain === 'eth') {
    // Reservoir fallback
    try {
      const res = await fetch(`https://api.reservoir.tools/tokens/v6?tokens=${contractAddress}:${tokenId}`, {
        headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
      });
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

    // Moralis fallback
    try {
      const res = await fetch(
        `https://deep-index.moralis.io/api/v2.2/nft/${contractAddress}/${tokenId}?chain=eth&format=decimal`,
        { headers: { 'X-API-Key': process.env.MORALIS_API_KEY } }
      );
      const data = await res.json();
      const raw = data?.metadata ? JSON.parse(data.metadata) : {};
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

  console.warn(`⚠️ Metadata fully unavailable after all fallback attempts`);
  return {};
}

module.exports = { fetchMetadata };



module.exports = { fetchMetadata };



