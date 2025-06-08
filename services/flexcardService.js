const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

const BASE_RPC = 'https://mainnet.base.org';
const provider = new JsonRpcProvider(BASE_RPC);

async function fetchMetadata(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    const tokenURI = await contract.tokenURI(tokenId);
    let metadataUrl = tokenURI;

    if (metadataUrl.startsWith('ipfs://')) {
      metadataUrl = metadataUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    const response = await fetch(metadataUrl);
    const metadata = await response.json();
    return metadata || {};
  } catch (err) {
    console.error('❌ Metadata fetch failed:', err);
    return {};
  }
}

async function fetchOwner(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    const owner = await contract.ownerOf(tokenId);
    return owner;
  } catch (err) {
    console.error('❌ Owner fetch failed:', err);
    return '0x0000000000000000000000000000000000000000';
  }
}

function shortenAddress(address) {
  if (!address || address.length < 10) return address || 'Unknown';
  return address.substring(0, 6) + '...' + address.substring(address.length - 4);
}

async function buildFlexCard(contractAddress, tokenId, collectionName) {
  const metadata = await fetchMetadata(contractAddress, tokenId);
  const owner = await fetchOwner(contractAddress, tokenId);
  const ownerDisplay = shortenAddress(owner);

  let nftImageUrl = metadata.image || null;
  if (nftImageUrl?.startsWith('ipfs://')) {
    nftImageUrl = nftImageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }

  if (!nftImageUrl) {
    console.warn('⚠️ No image found, using fallback image.');
    nftImageUrl = 'https://via.placeholder.com/400x400.png?text=No+Image';
  }

  const traits = Array.isArray(metadata.attributes) && metadata.attributes.length > 0
    ? metadata.attributes.map(attr => `${attr.trait_type} / ${attr.value}`)
    : ['No traits found'];

  const safeCollectionName = collectionName || metadata.name || "NFT";

  const openseaUrl = `https://opensea.io/assets/base/${contractAddress}/${tokenId}`;

  // 🔧 DEBUG LOGS FOR YOU
  console.log("🛠 FlexCard Build:");
  console.log("Image URL:", nftImageUrl);
  console.log("Collection Name:", safeCollectionName);
  console.log("Token ID:", tokenId);
  console.log("Traits:", traits);
  console.log("Owner:", ownerDisplay);
  console.log("OpenSea URL:", openseaUrl);

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

