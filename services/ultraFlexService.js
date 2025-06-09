const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
const { generateUltraFlexCard } = require('../utils/canvas/ultraFlexRenderer');
const { resolveENS } = require('../utils/ensResolver');
const { AbortController } = require('abort-controller');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

const BASE_RPC = 'https://mainnet.base.org';
const provider = new JsonRpcProvider(BASE_RPC);

// Timeout wrapper for fetch calls
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// Validate if remote image url is accessible
async function isImageValid(url, ms = 5000) {
  try {
    const res = await fetchWithTimeout(url, ms);
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchMetadata(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    const tokenURI = await contract.tokenURI(tokenId);
    let metadataUrl = tokenURI.startsWith('ipfs://')
      ? tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/')
      : tokenURI;

    const response = await fetchWithTimeout(metadataUrl);
    const metadata = await response.json();
    return metadata || {};
  } catch (err) {
    console.error('❌ Ultra Metadata fetch failed:', err);
    return {};
  }
}

async function fetchOwner(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    const owner = await contract.ownerOf(tokenId);
    return owner;
  } catch (err) {
    console.error('❌ Ultra Owner fetch failed:', err);
    return '0x0000000000000000000000000000000000000000';
  }
}

function shortenAddress(address) {
  if (!address || address.length < 10) return address || 'Unknown';
  return address.substring(0, 6) + '...' + address.substring(address.length - 4);
}

async function buildUltraFlexCard(contractAddress, tokenId, collectionName) {
  const metadata = await fetchMetadata(contractAddress, tokenId);
  const owner = await fetchOwner(contractAddress, tokenId);

  let ownerDisplay = await resolveENS(owner);
  if (!ownerDisplay) ownerDisplay = shortenAddress(owner);

  let nftImageUrl = metadata.image || metadata.image_url || null;
  if (nftImageUrl?.startsWith('ipfs://')) {
    nftImageUrl = nftImageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }

  const valid = nftImageUrl && /^https?:\/\//i.test(nftImageUrl) && await isImageValid(nftImageUrl);
  if (!valid) {
    nftImageUrl = null; // Let renderer fallback handle this
  }

  const traits = Array.isArray(metadata.attributes) && metadata.attributes.length > 0
    ? metadata.attributes.map(attr => `${attr.trait_type} / ${attr.value}`)
    : ['No traits found'];

  const safeCollectionName = collectionName || metadata.name || "NFT";
  const openseaUrl = `https://opensea.io/assets/base/${contractAddress}/${tokenId}`;

  const imageBuffer = await generateUltraFlexCard({
    nftImageUrl,
    collectionName: safeCollectionName,
    tokenId,
    traits,
    owner: ownerDisplay,
    openseaUrl
  });

  return imageBuffer;
}

module.exports = { buildUltraFlexCard };






