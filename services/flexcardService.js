const { Contract } = require('ethers');
const { getProvider } = require('./provider');
const { fetchMetadata } = require('../utils/fetchMetadata');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');

const abi = ['function ownerOf(uint256 tokenId) view returns (address)'];

function shortenAddress(address) {
  if (!address || address.length < 10) return address || 'Unknown';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function fetchOwner(contractAddress, tokenId, chain = 'base') {
  try {
    const provider = getProvider(chain);
    const contract = new Contract(contractAddress, abi, provider); // ✅ no .connect()
    return await contract.ownerOf(tokenId);
  } catch (err) {
    console.error('❌ Owner fetch failed:', err);
    return '0x0000000000000000000000000000000000000000';
  }
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
    nftImageUrl = 'https://i.imgur.com/EVQFHhA.png'; // ✅ avoids via.placeholder.com
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










