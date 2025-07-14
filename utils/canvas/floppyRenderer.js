// ✅ utils/canvas/floppyRenderer.js with static QR fallback
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { fetchMetadataExtras } = require('../../utils/fetchMetadataExtras');

async function buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath) {
  const canvas = createCanvas(600, 600);
  const ctx = canvas.getContext('2d');

  try {
    const meta = await fetchMetadataExtras(contractAddress, tokenId, chain);
    const nftImage = await loadImage(meta.image_fixed || meta.image || 'https://via.placeholder.com/400x400.png?text=NFT');
    const floppyImage = await loadImage(floppyPath);
    const qrImage = await loadImage('https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=' + encodeURIComponent(meta.permalink || `https://basescan.org/token/${contractAddress}?a=${tokenId}`));

    ctx.drawImage(floppyImage, 0, 0, 600, 600);
    ctx.drawImage(nftImage, 60, 140, 200, 200);
    ctx.drawImage(qrImage, 420, 430, 130, 130);

    ctx.font = 'bold 22px Arial';
    ctx.fillStyle = '#111';
    ctx.fillText(`${collectionName}`, 60, 370);
    ctx.fillText(`ID #${tokenId}`, 60, 400);
    ctx.fillText(`Rank: ${meta.rank || 'N/A'}`, 60, 430);
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


