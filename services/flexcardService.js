const { Contract } = require('ethers');
const { getProvider } = require('../utils/provider');
const { fetchMetadata } = require('../utils/fetchMetadata');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

// ✅ Smart validation to ensure provider supports calls
async function fetchOwner(contractAddress, tokenId, chain) {
  try {
    const provider = getProvider(chain);

    // ⚠️ Some providers don't support .call() unless manually done in Ethers v6
    const contract = new Contract(contractAddress, [
      'function ownerOf(uint256 tokenId) view returns (address)'
    ], provider);

    const callData = contract.interface.encodeFunctionData('ownerOf', [tokenId]);
    const result = await provider.call({ to: contractAddress, data: callData });
    const [owner] = contract.interface.decodeFunctionResult('ownerOf', result);

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





