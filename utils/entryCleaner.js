const path = require('path');
const { extractValidAddress } = require('./inputCleaner');

function cleanNFTData(rawNFT) {
  const {
    imageUrl,
    collectionName,
    tokenId,
    traits,
    owner,
    openseaUrl
  } = rawNFT;

  // Correctly resolve local fallback image as file:// URI
  const fallbackImagePath = path.join(__dirname, '../assets/fallback.png');
  const cleanImage = imageUrl || `file://${fallbackImagePath}`;

  const cleanTraits = Array.isArray(traits)
    ? traits.map(t => t.toString())
    : [];

  let rawOwner = null;
  if (typeof owner === 'string') {
    rawOwner = extractValidAddress(owner);
  } else if (typeof owner === 'object' && owner.address) {
    rawOwner = extractValidAddress(owner.address);
  }
  const cleanOwner = rawOwner || null;

  return {
    nftImageUrl: cleanImage,
    collectionName: collectionName || 'Unknown Collection',
    tokenId: tokenId || '???',
    traits: cleanTraits,
    owner: cleanOwner,
    openseaUrl: openseaUrl || 'https://opensea.io'
  };
}

module.exports = { cleanNFTData };




