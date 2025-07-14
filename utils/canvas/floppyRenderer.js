// ✅ utils/canvas/floppyRenderer.js final layout
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const path = require('path');
const { fetchMetadataExtras } = require('../../utils/fetchMetadataExtras');

async function buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath) {
  const canvas = createCanvas(600, 600);
  const ctx = canvas.getContext('2d');

  try {
    const meta = await fetchMetadataExtras(contractAddress, tokenId, chain);
    const localPlaceholder = path.resolve(__dirname, '../../assets/placeholders/nft-placeholder.png');
    const nftImage = await loadImage(meta.image_fixed || meta.image || localPlaceholder);
    const floppyImage = await loadImage(floppyPath);
    const qrImage = await loadImage('https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=' + encodeURIComponent(meta.permalink || `https://basescan.org/token/${contractAddress}?a=${tokenId}`));

    ctx.drawImage(floppyImage, 0, 0, 600, 600);
    ctx.drawImage(nftImage, 60, 140, 140, 140);
    ctx.drawImage(qrImage, 400, 440, 130, 130);

    ctx.font = 'bold 18px Arial';
    ctx.fillStyle = '#111';
    ctx.fillText(`${collectionName}`, 220, 160);
    ctx.fillText(`ID #${tokenId}`, 220, 190);
    ctx.fillText(`Rank: ${meta.rank || 'N/A'}`, 220, 220);
    ctx.fillText(`Minted with $ADRIAN on Base`, 60, 300);
  } catch (err) {
    console.warn('❌ buildFloppyCard error:', err);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, 600, 600);
    ctx.font = 'bold 30px Arial';
    ctx.fillStyle = '#fff';
    ctx.fillText('Error Loading NFT', 150, 300);
  }

  return canvas.toBuffer('image/png');
}

module.exports = {
  buildFloppyCard
};



