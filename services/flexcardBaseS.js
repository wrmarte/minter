const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');
const { fetchMetadataExtras } = require('../utils/fetchMetadataExtras');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

const provider = new JsonRpcProvider('https://mainnet.base.org');

function shortenAddress(address) {
  if (!address || address.length < 10) return address || 'Unknown';
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

const { Contract } = require('ethers');
const fetch = require('node-fetch');
const { getProvider } = require('./provider'); // or however you load your provider

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)'
];

async function fetchMetadata(contractAddress, tokenId) {
  try {
    const provider = getProvider('base');
    const contract = new Contract(contractAddress, abi, provider);
    const tokenURI = await contract.tokenURI(tokenId);

    const metadataUrl = tokenURI.startsWith('ipfs://')
      ? tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/')
      : tokenURI;

    const res = await fetch(metadataUrl, { timeout: 7000 });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      console.warn(`⚠️ Invalid metadata content-type (${contentType}) at ${metadataUrl}`);
      const text = await res.text();
      console.warn('Returned text:', text.slice(0, 100));
      return null;
    }

    const json = await res.json();
    if (!json || !json.image) {
      console.warn(`⚠️ Metadata missing expected fields for token ${tokenId}`);
    }

    return json;
  } catch (err) {
    console.error('❌ Metadata fetch failed:', err.message);
    return null;
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

async function buildFlexCard(contractAddress, tokenId, collectionName) {
  // ⛏️ Fetch metadata and owner info
  const metadata = await fetchMetadata(contractAddress, tokenId);
  const owner = await fetchOwner(contractAddress, tokenId);
  const ownerDisplay = shortenAddress(owner);

  // 🖼️ Normalize image URL
  let nftImageUrl = metadata?.image || 'https://i.imgur.com/EVQFHhA.png';
  if (nftImageUrl.startsWith('ipfs://')) {
    nftImageUrl = nftImageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }

  // 🧬 Parse traits
  const traits = Array.isArray(metadata?.attributes) && metadata.attributes.length > 0
    ? metadata.attributes.map(attr => `${attr.trait_type} / ${attr.value}`)
    : ['No traits found'];

  // 🔖 Fallback-safe collection name
  const safeCollectionName = collectionName || metadata?.name || 'NFT';

  // 🌊 Opensea URL
  const openseaUrl = `https://opensea.io/assets/base/${contractAddress}/${tokenId}`;

  // 🧠 Extra metadata: mint date, rarity, network, total supply
  const extras = await fetchMetadataExtras(contractAddress, tokenId, 'base');

  // ✅ Optional logging for debug
  if (extras.rank === 'N/A' || extras.score === 'N/A') {
    console.warn(`⚠️ Incomplete rarity data for Token ${tokenId} — Rank: ${extras.rank}, Score: ${extras.score}`);
  }
  if (extras.minted === 'Unknown') {
    console.warn(`⚠️ Minted date not found for Token ${tokenId}`);
  }

  return await generateFlexCard({
    nftImageUrl,
    collectionName: safeCollectionName,
    tokenId,
    traits,
    owner: ownerDisplay,
    openseaUrl,
    ...extras // Injects: minted, rank, score, network, totalSupply
  });
}

module.exports = { buildFlexCard };







