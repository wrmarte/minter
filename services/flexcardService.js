const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

// You can later enhance to rotate RPCs (your usual system)
const BASE_RPC = 'https://mainnet.base.org';
const provider = new JsonRpcProvider(BASE_RPC);

async function fetchMetadata(contractAddress, tokenId) {
  const contract = new Contract(contractAddress, abi, provider);

  const tokenURI = await contract.tokenURI(tokenId);
  let metadataUrl = tokenURI;

  // Handle if URI is IPFS
  if (metadataUrl.startsWith('ipfs://')) {
    metadataUrl = metadataUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }

  const response = await fetch(metadataUrl);
  const metadata = await response.json();
  return metadata;
}

async function fetchOwner(contractAddress, tokenId) {
  const contract = new Contract(contractAddress, abi, provider);
  const owner = await contract.ownerOf(tokenId);
  return owner;
}

function shortenAddress(address) {
  return address.substring(0, 6) + '...' + address.substring(address.length - 4);
}

async function buildFlexCard(contractAddress, tokenId, collectionName) {
  const metadata = await fetchMetadata(contractAddress, tokenId);
  const owner = await fetchOwner(contractAddress, tokenId);
  const ownerDisplay = shortenAddress(owner);

  const nftImageUrl = metadata.image.startsWith('ipfs://')
    ? metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
    : metadata.image;

  const traits = metadata.attributes.map(attr => `${attr.trait_type} / ${attr.value}`);

  const openseaUrl = `https://opensea.io/assets/base/${contractAddress}/${tokenId}`;

  const imageBuffer = await generateFlexCard({
    nftImageUrl,
    collectionName,
    tokenId,
    traits,
    owner: ownerDisplay,
    openseaUrl
  });

  return imageBuffer;
}

module.exports = { buildFlexCard };
