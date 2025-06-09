const { Contract } = require('ethers');
const { getProvider } = require('../utils/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');
const { generateUltraFlexCard } = require('../utils/canvas/ultraFlexRenderer');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

async function fetchOwner(contractAddress, tokenId, chain) {
  try {
    const provider = getProvider(chain);
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

async function buildUltraFlexCard(contractAddress, tokenId, collectionName, chain) {
  const metadata = await fetchMetadata(contractAddress, tokenId, chain);
  const owner = await fetchOwner(contractAddress, tokenId, chain);
  const ownerDisplay = shortenAddress(owner);

  let nftImageUrl = metadata.image || metadata.image_url || null;
  if (nftImageUrl?.startsWith('ipfs://')) {
    nftImageUrl = nftImageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }
  if (!nftImageUrl) {
    nftImageUrl = null;
  }

  const traits = Array.isArray(metadata.attributes) && metadata.attributes.length > 0
    ? metadata.attributes.map(attr => `${attr.trait_type} / ${attr.value}`)
    : ['No traits found'];

  const safeCollectionName = collectionName || metadata.name || "NFT";
  const openseaUrl = chain === 'eth'
    ? `https://opensea.io/assets/ethereum/${contractAddress}/${tokenId}`
    : `https://opensea.io/assets/${chain}/${contractAddress}/${tokenId}`;

  const imageBuffer = await generateUltraFlexCard({
    nftImageUrl,
    collectionName: safeCollectionName,
    tokenId,
    traits,
    ownerDisplay,
    owner,
    openseaUrl
  });

  return imageBuffer;
}

module.exports = { buildUltraFlexCard };









