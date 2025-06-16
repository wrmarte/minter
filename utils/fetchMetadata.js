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

function deepExtractAttributes(meta) {
  const candidates = [
    meta?.attributes,
    meta?.traits,
    meta?.properties?.traits,
    meta?.metadata?.attributes,
    meta?.token?.attributes,
    meta?.token?.metadata?.attributes,
    Array.isArray(meta) ? meta : null
  ];

  for (const entry of candidates) {
    if (Array.isArray(entry) && entry.length > 0 && entry[0].hasOwnProperty('trait_type')) {
      return entry;
    }
  }

  // Handle object form (trait_type: value)
  if (typeof meta?.attributes === 'object' && !Array.isArray(meta.attributes)) {
    return Object.entries(meta.attributes).map(([trait_type, value]) => ({ trait_type, value }));
  }

  return [];
}

async function fetchMetadata(contractAddress, tokenId, chain = 'base') {
  chain = chain.toLowerCase();

  // 1. Reservoir first
  try {
    const res = await fetch(`https://api.reservoir.tools/tokens/v6?tokens=${contractAddress}:${tokenId}`, {
      headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
    });
    const data = await res.json();
    const token = data?.tokens?.[0]?.token;
    if (token?.image) {
      const traits = token.attributes || [];
      if (traits.length > 0) {
        console.log('🧬 [Reservoir] Extracted traits:', traits);
        return { image: token.image, attributes: traits };
      } else {
        console.warn(`⚠️ [Reservoir] Empty traits, will try fallback...`);
      }
    }
  } catch (err) {
    console.warn(`⚠️ Reservoir failed: ${err.message}`);
  }

  // 2. tokenURI fallback with existence check
  try {
    const provider = await getProvider(chain);
    const contract = new Contract(contractAddress, abi, provider);

    // ✅ Token existence check
    try {
      await contract.ownerOf(tokenId);
    } catch {
      console.warn(`❌ Token #${tokenId} does not exist on ${chain.toUpperCase()} (${contractAddress})`);
      return {}; // skip non-existent token
    }

    const tokenURI = await contract.tokenURI(tokenId);
    const metadataUrl = fixIpfs(tokenURI);
    const raw = await safeFetchJson(metadataUrl);

    if (raw?.image) {
      const extracted = deepExtractAttributes(raw);
      console.log('🧬 [tokenURI] Extracted:', extracted);
      return {
        image: fixIpfs(raw.image),
        attributes: extracted
      };
    }
  } catch (err) {
    console.warn(`⚠️ tokenURI fetch failed: ${err.message}`);
  }

  // 3. Moralis fallback (ETH only)
  if (chain === 'eth') {
    try {
      const res = await fetch(
        `https://deep-index.moralis.io/api/v2.2/nft/${contractAddress}/${tokenId}?chain=eth&format=decimal`,
        { headers: { 'X-API-Key': process.env.MORALIS_API_KEY } }
      );
      const data = await res.json();
      const raw = data?.metadata ? JSON.parse(data.metadata) : {};
      if (raw?.image) {
        const extracted = deepExtractAttributes(raw);
        console.log('🧬 [Moralis] Extracted:', extracted);
        return {
          image: fixIpfs(raw.image),
          attributes: extracted
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











