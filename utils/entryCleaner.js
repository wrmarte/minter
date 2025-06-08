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

  const cleanImage = imageUrl || 'https://via.placeholder.com/1024x1024.png?text=NO+IMAGE';

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

