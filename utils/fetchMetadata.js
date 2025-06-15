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

function deepExtractAttributes(metadata) {
  const tryList = [
    metadata?.attributes,
    metadata?.traits,
    metadata?.properties?.traits,
    metadata?.metadata?.attributes,
    metadata?.meta?.attributes,
    metadata?.token?.attributes,
    metadata?.token?.metadata?.attributes,
    metadata?.details?.attributes,
    metadata?.properties?.attributes
  ];

  for (const candidate of tryList) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }

  // Handle object-style traits (e.g. { background: 'blue', hat: 'cap' })
  if (typeof metadata?.attributes === 'object' && !Array.isArray(metadata.attributes)) {
    return Object.entries(metadata.attributes).map(([trait_type, value]) => ({ trait_type, value }));
  }

  return [];
}

async function fetchMetadata(contractAddress, tokenId, chain = 'base') {
  chain = chain.toLowerCase();

  // ✅ 1. Try Reservoir first
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
    console.warn(`⚠️ Reservoir failed: ${err.message}`);
  }

  // ✅ 2. Try tokenURI from contract
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
      return {
        image: fixIpfs(meta.image),
        attributes: deepExtractAttributes(meta)
      };
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
        return {
          image: fixIpfs(raw.image),
          attributes: deepExtractAttributes(raw)
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









