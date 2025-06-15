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

function extractTraits(token) {
  if (Array.isArray(token?.attributes)) return token.attributes;
  if (Array.isArray(token?.traits)) return token.traits;
  if (Array.isArray(token?.metadata?.attributes)) return token.metadata.attributes;
  if (typeof token?.attributes === 'object') {
    return Object.entries(token.attributes).map(([trait_type, value]) => ({ trait_type, value }));
  }
  return [];
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

  // ✅ 1. Try Reservoir first (for ALL chains)
  try {
    const res = await fetch(`https://api.reservoir.tools/tokens/v6?tokens=${contractAddress}:${tokenId}`, {
      headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
    });
    const data = await res.json();
    const token = data?.tokens?.[0]?.token;
    if (token?.image) {
      const attributes = extractTraits(token);
      if (attributes.length > 0) {
        const extracted = {
          image: fixIpfs(token.image),
          attributes
        };
        console.log('🧬 [Reservoir] Extracted:', JSON.stringify(extracted, null, 2));
        return extracted;
      } else {
        console.warn('⚠️ Reservoir returned image but no traits. Trying fallback...');
      }
    }
  } catch (err) {
    console.warn(`⚠️ Reservoir failed: ${err.message}`);
  }

  // ✅ 2. Try native contract fetch
  try {
    const provider = await getProvider(chain);
    const contract = new Contract(contractAddress, abi, provider);

    try {
      await contract.ownerOf(tokenId);
    } catch (err) {
      const msg = err?.error?.message || err?.reason || err?.message || '';
      const isNotMinted = msg.toLowerCase().includes('nonexistent') || msg.toLowerCase().includes('invalid token');
      if (isNotMinted) throw new Error(`Token ${tokenId} not minted yet`);
      console.warn(`⚠️ ownerOf failed but continuing: ${msg}`);
    }

    const tokenURI = await contract.tokenURI(tokenId);
    const metadataUrl = fixIpfs(tokenURI);
    if (!metadataUrl) throw new Error('Empty tokenURI');

    const meta = await safeFetchJson(metadataUrl);
    if (meta?.image) {
      console.log('🧬 Raw metadata:', JSON.stringify(meta, null, 2));
      return meta;
    }
  } catch (err) {
    console.warn(`⚠️ tokenURI fetch failed on ${chain}: ${err.message}`);
  }

  // ✅ 3. Moralis fallback for ETH only
  if (chain === 'eth') {
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







