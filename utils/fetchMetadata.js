const { Contract } = require('ethers');
const fetch = require('node-fetch');
const { getProvider } = require('../services/provider');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

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

  // ✅ 1. ETH special case — try native tokenURI first
  if (chain === 'eth') {
    try {
      const provider = await getProvider(chain);
      const contract = new Contract(contractAddress, abi, provider);

      const tokenURI = await contract.tokenURI(tokenId);
      const metadataUrl = fixIpfs(tokenURI);
      if (!metadataUrl) throw new Error('Empty tokenURI');

      const meta = await safeFetchJson(metadataUrl);
      if (meta?.image) {
        console.log('🧬 [ETH Native] Extracted:', JSON.stringify(meta, null, 2));
        return {
          image: fixIpfs(meta.image),
          attributes: meta.attributes || []
        };
      }
    } catch (err) {
      console.warn(`⚠️ ETH tokenURI failed: ${err.message}`);
    }
  }

  // ✅ 2. Reservoir fallback
  try {
    const res = await fetch(`https://api.reservoir.tools/tokens/v6?tokens=${contractAddress}:${tokenId}`, {
      headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
    });
    const data = await res.json();
    const token = data?.tokens?.[0]?.token;

    const image = token?.image;
    let attributes = token?.attributes || [];

    if ((!attributes || attributes.length === 0) && token?.metadata?.attributes) {
      attributes = token.metadata.attributes;
    }

    console.log('🧬 [Reservoir] Extracted:', JSON.stringify({ image, attributes }, null, 2));

    if (image) {
      return {
        image,
        attributes
      };
    }
  } catch (err) {
    console.warn(`⚠️ Reservoir failed: ${err.message}`);
  }

  // ✅ 3. Moralis fallback
  if (chain === 'eth') {
    try {
      const res = await fetch(
        `https://deep-index.moralis.io/api/v2.2/nft/${contractAddress}/${tokenId}?chain=eth&format=decimal`,
        { headers: { 'X-API-Key': process.env.MORALIS_API_KEY } }
      );
      const data = await res.json();
      const raw = data?.metadata ? JSON.parse(data.metadata) : {};
      if (raw?.image) {
        console.log('🧬 [Moralis] Extracted:', JSON.stringify(raw, null, 2));
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








