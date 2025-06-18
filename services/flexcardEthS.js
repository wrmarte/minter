const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function totalSupply() view returns (uint256)' // optional, used if public
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
    const data = await res.json();
    return data || {};
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

async function fetchRarity(contractAddress, tokenId) {
  try {
    const url = `https://api.traitsniper.com/v1/collections/${contractAddress.toLowerCase()}/tokens/${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TraitSniper response not ok: ${res.statusText}`);
    const json = await res.json();
    return {
      rank: json?.rank || 'N/A',
      score: json?.score || 'N/A'
    };
  } catch (e) {
    console.warn('⚠️ TraitSniper fallback:', e.message);
    return { rank: 'N/A', score: 'N/A' };
  }
}

async function fetchTotalSupply(contractAddress) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    return (await contract.totalSupply())?.toString();
  } catch (err) {
    console.warn('⚠️ Total supply fetch failed:', err.message);
    return 'N/A';
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

  const { rank, score } = await fetchRarity(contractAddress, tokenId);
  const totalSupply = await fetchTotalSupply(contractAddress);

  const mintedDate = metadata?.minted_date ?? null; // Placeholder only, true date requires Transfer event lookup
  const safeCollectionName = collectionName || metadata?.name || 'NFT';
  const openseaUrl = `https://opensea.io/assets/ethereum/${contractAddress}/${tokenId}`;

  return await generateFlexCard({
    nftImageUrl,
    collectionName: safeCollectionName,
    tokenId,
    traits,
    owner: ownerDisplay,
    openseaUrl,
    rank,
    score,
    mintedDate,
    network: 'Ethereum',
    totalSupply
  });
}

module.exports = { buildFlexCard };

