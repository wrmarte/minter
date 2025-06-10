const { Contract } = require('ethers');
const { getProvider } = require('../utils/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

async function fetchOwner(contractAddress, tokenId, chain = 'base') {
  try {
    const provider = getProvider(chain);
    const contract = new Contract(contractAddress, abi, provider); // ✅ pass provider as runner
    const owner = await contract.ownerOf(tokenId); // ✅ supported
    return owner;
  } catch (err) {
    console.error('❌ Owner fetch failed:', err.message);
    return '0x0000000000000000000000000000000000000000';
  }
}

function shortenAddress(address) {
  if (!address || address.length < 10) return address || 'Unknown';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function buildFlexCard(contractAddress, tokenId, collectionName, chain = 'base') {
  const metadata = await fetchMetadata(contractAddress, tokenId, chain);
  const owner = await fetchOwner(contractAddress, tokenId, chain);
  const ownerDisplay = shortenAddress(owner);

  let nftImageUrl = metadata?.image || null;
  if (nftImageUrl?.startsWith('ipfs://')) {
    nftImageUrl = nftImageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }
  if (!nftImageUrl) {
    nftImageUrl = 'https://via.placeholder.com/400x400.png?text=No+Image';
  }

  const traits = Array.isArray(metadata?.attributes) && metadata.attributes.length > 0
    ? metadata.attributes.map(attr => `${attr.trait_type} / ${attr.value}`)
    : ['No traits found'];

  const safeCollectionName = collectionName || metadata?.name || "NFT";

  const openseaUrl = `https://opensea.io/assets/base/${contractAddress}/${tokenId}`;

  const imageBuffer = await generateFlexCard({
    nftImageUrl,
    collectionName: safeCollectionName,
    tokenId,
    traits,
    owner: ownerDisplay,
    openseaUrl
  });

  return imageBuffer;
}

module.exports = { buildFlexCard };






