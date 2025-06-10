const { Contract } = require('ethers');
const { getProvider } = require('../utils/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

async function fetchOwner(contractAddress, tokenId, chain) {
  try {
    const provider = getProvider(chain);

    // ✅ Log which provider is being used (Ethers v6+)
    const rpcUrl = provider?.transport?.url || '[unknown]';
    console.log(`🔍 Using provider for ${chain.toUpperCase()}: ${rpcUrl}`);

    // ✅ Validate if provider supports calling contracts
    if (typeof provider.call !== 'function') {
      throw new Error('❌ Provider does not support contract calls');
    }

    // ✅ Properly connect contract to the runner-compatible provider
    const contract = new Contract(contractAddress, abi).connectRunner(provider);

    // ✅ Call ownerOf
    const owner = await contract.ownerOf(tokenId);
    return owner;
  } catch (err) {
    console.error('❌ Owner fetch failed:', err);
    return '0x0000000000000000000000000000000000000000';
  }
}





function shortenAddress(address) {
  if (!address || address === '0x0000000000000000000000000000000000000000') return 'Unknown';
  if (address.length !== 42) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}


async function buildFlexCard(contractAddress, tokenId, collectionName, chain) {
  const metadata = await fetchMetadata(contractAddress, tokenId, chain);
  const owner = await fetchOwner(contractAddress, tokenId, chain);
  const ownerDisplay = shortenAddress(owner);

  let nftImageUrl = metadata.image || null;
  if (nftImageUrl?.startsWith('ipfs://')) {
    nftImageUrl = nftImageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
  }
  if (!nftImageUrl) {
    nftImageUrl = 'https://via.placeholder.com/400x400.png?text=No+Image';
  }

  const traits = Array.isArray(metadata.attributes) && metadata.attributes.length > 0
    ? metadata.attributes.map(attr => `${attr.trait_type} / ${attr.value}`)
    : ['No traits found'];

  const safeCollectionName = collectionName || metadata.name || "NFT";

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



