const { Contract, JsonRpcProvider } = require('ethers');
const { getProvider } = require('../utils/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

// Ethers v6: Must connect contract to a Runner (provider) for .call()
async function fetchOwner(contractAddress, tokenId, chain) {
  try {
    const provider = getProvider(chain);
    const abi = ['function ownerOf(uint256 tokenId) view returns (address)'];

    // 🔒 Forcibly connect the provider as runner
    const contract = new Contract(contractAddress, abi).connect(provider);

    // ✅ This now guarantees the runner supports `.call()`
    const owner = await contract.ownerOf(tokenId);
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

async function buildFlexCard(contractAddress, tokenId, collectionName, chain) {
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
  const openseaUrl = chain === 'eth'
    ? `https://opensea.io/assets/ethereum/${contractAddress}/${tokenId}`
    : `https://opensea.io/assets/${chain}/${contractAddress}/${tokenId}`;

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











