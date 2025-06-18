const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

const provider = new JsonRpcProvider('https://eth.llamarpc.com');

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

async function buildFlexCard(contractAddress, tokenId, collectionName) {
  const metadata = await fetchMetadata(contractAddress, tokenId);
  const owner = await fetchOwner(contractAddress, tokenId);
  const ownerDisplay = shortenAddress(owner);

  // Fallback for image
  let nftImageUrl = metadata?.image || 'https://i.imgur.com/EVQFHhA.png';
  if (nftImageUrl.startsWith('ipfs://')) {
    nftImageUrl = nftImageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }

  // Trait extraction with fallback
  let rawTraits = metadata?.attributes || metadata?.traits || [];
  const traits = Array.isArray(rawTraits) && rawTraits.length > 0
    ? rawTraits.map(attr => `${attr.trait_type || attr.trait} / ${attr.value}`)
    : ['No traits found'];

  const rank = metadata?.rank ?? metadata?.rarity_rank ?? 'N/A';
  const score = metadata?.score ?? metadata?.rarity_score ?? 'N/A';

  const mintedDate = metadata?.minted_date ?? null;
  const totalSupply = metadata?.total_supply ?? 'N/A';
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

