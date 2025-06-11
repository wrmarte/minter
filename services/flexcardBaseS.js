// flexcardBaseService.js
const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');
const { fetchMetadataExtras } = require('../utils/fetchMetadataExtras'); // ✅ new import

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function totalSupply() view returns (uint256)' // ✅ optional
];

const provider = new JsonRpcProvider('https://mainnet.base.org');

function shortenAddress(address) {
  if (!address || address.length < 10) return address || 'Unknown';
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

async function fetchMetadata(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    const tokenURI = await contract.tokenURI(tokenId);
    const metadataUrl = tokenURI.startsWith('ipfs://')
      ? tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/')
      : tokenURI;
    const res = await fetch(metadataUrl);
    return await res.json();
  } catch (err) {
    console.error('❌ Metadata fetch failed:', err);
    return {};
  }
}

async function fetchOwner(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    return await contract.ownerOf(tokenId);
  } catch (err) {
    console.error('❌ Owner fetch failed:', err);
    return '0x0000000000000000000000000000000000000000';
  }
}

async function fetchReservoirRank(contractAddress, tokenId) {
  try {
    const res = await fetch(`https://api.reservoir.tools/tokens/v6?tokens=base:${contractAddress}:${tokenId}`);
    const json = await res.json();
    return json?.tokens?.[0]?.token?.rarity?.rank || 'N/A';
  } catch (err) {
    console.warn('⚠️ Reservoir rank fetch failed:', err);
    return 'N/A';
  }
}

async function fetchTotalSupply(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    const total = await contract.totalSupply();
    const totalStr = total.toString();
    if (parseInt(tokenId) < parseInt(totalStr)) {
      return `${totalStr} (Still minting)`;
    }
    return totalStr;
  } catch (err) {
    console.warn('⚠️ Total supply not available:', err);
    return 'Unknown';
  }
}

async function buildFlexCard(contractAddress, tokenId, collectionName) {
  const metadata = await fetchMetadata(contractAddress, tokenId);
  const owner = await fetchOwner(contractAddress, tokenId);
  const ownerDisplay = shortenAddress(owner);

  let nftImageUrl = metadata?.image || 'https://i.imgur.com/EVQFHhA.png';
  if (nftImageUrl.startsWith('ipfs://')) {
    nftImageUrl = nftImageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }

  const traits = Array.isArray(metadata?.attributes) && metadata.attributes.length > 0
    ? metadata.attributes.map(attr => `${attr.trait_type} / ${attr.value}`)
    : ['No traits found'];

  const safeCollectionName = collectionName || metadata?.name || 'NFT';
  const openseaUrl = `https://opensea.io/assets/base/${contractAddress}/${tokenId}`;

  const extras = await fetchMetadataExtras(contractAddress, tokenId, 'base');
  extras.rank = await fetchReservoirRank(contractAddress, tokenId);
  extras.totalSupply = await fetchTotalSupply(contractAddress, tokenId);

  return await generateFlexCard({
    nftImageUrl,
    collectionName: safeCollectionName,
    tokenId,
    traits,
    owner: ownerDisplay,
    openseaUrl,
    ...extras // ✅ inject metadata
  });
}

module.exports = { buildFlexCard };



