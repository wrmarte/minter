// floppyFlexService.js
const { buildFloppyFlexRenderer } = require('../utils/canvas/floppyRenderer');
const { fetchMetadata } = require('../utils/fetchMetadata');

async function buildFloppyFlexCard(contractAddress, tokenId, collectionName, chain) {
  try {
    const meta = await fetchMetadata(contractAddress, tokenId, chain);
    if (!meta) throw new Error('Metadata unavailable.');

    const floppyCard = await buildFloppyFlexRenderer({
      image: meta.image,
      traits: meta.attributes || meta.traits || [],
      tokenId,
      collectionName,
      opensea_url: meta.opensea_url || null,
      rank: meta.rank || 'N/A'
    });

    return floppyCard;
  } catch (err) {
    console.error('❌ Floppy FlexCard service error:', err);
    throw err;
  }
}

module.exports = { buildFloppyFlexCard };
