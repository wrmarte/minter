// services/cardEthS.js
const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');
const { fetchMetadataExtras } = require('../utils/fetchMetadataExtras');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

const provider = new JsonRpcProvider('https://eth.llamarpc.com');

function shortenAddress(address) {
  if (!address || address.length < 10) return address || 'Unknown';
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

function fixIpfs(url) {
  return url?.startsWith('ipfs://') ? url.replace('ipfs://', 'https://ipfs.io/ipfs/') : url;
}

async function fetchMetadata(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    const tokenURI = await contract.tokenURI(tokenId);
    const metadataUrl = fixIpfs(tokenURI);

    const res = await fetch(metadataUrl);
    if (!res.ok) throw new Error(`Metadata fetch failed: ${res.statusText}`);
    return await res.json();
  } catch (err) {
    console.error('❌ Metadata fetch failed (ETH):', err);
    return {};
  }
}

async function fetchOwner(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    return await contract.ownerOf(tokenId);
  } catch (err) {
    console.error('❌ Owner fetch failed (ETH):', err);
    return '0x0000000000000000000000000000000000000000';
  }
}

async function buildFlexCard(contractAddress, tokenId, collectionName) {
  const metadata = await fetchMetadata(contractAddress, tokenId);
  const owner = await fetchOwner(contractAddress, tokenId);
  const ownerDisplay = shortenAddress(owner);

  let nftImageUrl = fixIpfs(metadata?.image) || 'https://i.imgur.com/EVQFHhA.png';

  let rawTraits = metadata?.attributes || metadata?.traits || [];
  const traits = Array.isArray(rawTraits) && rawTraits.length > 0
    ? rawTraits.map(attr => `${attr.trait_type || attr.trait} / ${attr.value}`)
    : ['No traits found'];

  const safeCollectionName = collectionName || metadata?.name || 'NFT';
  const openseaUrl = `https://opensea.io/assets/ethereum/${contractAddress}/${tokenId}`;

  // 💡 New: Extras from unified metadata fetcher
  const extras = await fetchMetadataExtras(contractAddress, tokenId, 'ethereum');

  // ✅ Optional logs
  if (extras.rank === 'Unavailable' || extras.score === '—') {
    console.warn(`⚠️ Incomplete rarity for Token ${tokenId} — Rank: ${extras.rank}, Score: ${extras.score}`);
  }

  return await generateFlexCard({
    nftImageUrl,
    collectionName: safeCollectionName,
    tokenId,
    traits,
    owner: ownerDisplay,
    openseaUrl,
    ...extras // Injects: mintedDate, rank, score, network, totalSupply
  });
}

module.exports = { buildFlexCard };




