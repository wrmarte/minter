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

function extractTraits(meta) {
  if (!meta) return [];

  if (Array.isArray(meta.attributes)) return meta.attributes;
  if (Array.isArray(meta.traits)) return meta.traits;
  if (Array.isArray(meta.metadata?.attributes)) return meta.metadata.attributes;
  if (Array.isArray(meta.token?.attributes)) return meta.token.attributes;
  if (Array.isArray(meta.token?.metadata?.attributes)) return meta.token.metadata.attributes;

  if (typeof meta.attributes === 'object') {
    return Object.entries(meta.attributes).map(([trait_type, value]) => ({ trait_type, value }));
  }

  return [];
}

async function fetchMetadata(contractAddress, tokenId, chain = 'base') {
  chain = chain.toLowerCase();

  // ✅ 1. Reservoir API (unified)
  try {
    const res = await fetch(`https://api.reservoir.tools/tokens/v6?tokens=${contractAddress}:${tokenId}`, {
      headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
    });
    const data = await res.json();
    const token = data?.tokens?.[0]?.token;
    if (token?.image) {
      const extracted = {
        image: fixIpfs(token.image),
        attributes: extractTraits(token)
      };
      console.log('🧬 [Reservoir] Extracted:', JSON.stringify(extracted, null, 2));
      return extracted;
    }
  } catch (err) {
    console.warn(`⚠️ Reservoir failed: ${err.message}`);
  }

  // ✅ 2. On-chain metadata
  try {
    const provider = await getProvider(chain);
    const contract = new Contract(contractAddress, abi, provider);

    try {
      await contract.ownerOf(tokenId);
    } catch (err) {
      const msg = err?.error?.message || err?.reason || err?.message || '';
      const isNotMinted = msg.toLowerCase().includes('nonexistent') || msg.toLowerCase().includes('invalid token');
      if (isNotMinted) throw new Error(`Token ${tokenId} not minted yet`);
    }

    const tokenURI = await contract.tokenURI(tokenId);
    const metadataUrl = fixIpfs(tokenURI);
    const meta = await safeFetchJson(metadataUrl);
    if (meta?.image) {
      const extracted = {
        image: fixIpfs(meta.image),
        attributes: extractTraits(meta)
      };
      console.log('🧬 [On-Chain] Extracted:', JSON.stringify(extracted, null, 2));
      return extracted;
    }
  } catch (err) {
    console.warn(`⚠️ tokenURI fetch failed on ${chain}: ${err.message}`);
  }

  // ✅ 3. Moralis fallback (ETH only)
  if (chain === 'eth') {
    try {
      const res = await fetch(
        `https://deep-index.moralis.io/api/v2.2/nft/${contractAddress}/${tokenId}?chain=eth&format=decimal`,
        { headers: { 'X-API-Key': process.env.MORALIS_API_KEY } }
      );
      const data = await res.json();
      const raw = data?.metadata ? JSON.parse(data.metadata) : {};
      if (raw?.image) {
        const extracted = {
          image: fixIpfs(raw.image),
          attributes: extractTraits(raw)
        };
        console.log('🧬 [Moralis] Extracted:', JSON.stringify(extracted, null, 2));
        return extracted;
      }
    } catch (err) {
      console.warn(`⚠️ Moralis fallback failed: ${err.message}`);
    }
  }

  console.warn(`⚠️ Metadata fully unavailable after all fallback attempts`);
  return {};
}

module.exports = { fetchMetadata };







