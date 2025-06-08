const { extractValidAddress, shortenAddress } = require('./inputCleaner');

// NFT upstream cleaner
function cleanNFTData(rawNFT) {
  const {
    imageUrl,
    collectionName,
    tokenId,
    traits,
    owner,
    openseaUrl
  } = rawNFT;

  // Sanitize traits (always array of strings)
  const cleanTraits = Array.isArray(traits)
    ? traits.map(t => t.toString())
    : [];

  // Extract owner address safely
  let rawOwner = null;

  if (typeof owner === 'string') {
    rawOwner = extractValidAddress(owner);
  } else if (typeof owner === 'object' && owner.address) {
    rawOwner = extractValidAddress(owner.address);
  }

  // If not valid address, fallback to null
  const cleanOwner = rawOwner || null;

  return {
    nftImageUrl: imageUrl,
    collectionName,
    tokenId,
    traits: cleanTraits,
    owner: cleanOwner,
    openseaUrl
  };
}

module.exports = { cleanNFTData };
