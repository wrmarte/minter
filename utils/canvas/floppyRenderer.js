// ✅ utils/canvas/floppyRenderer.js pinned layout with measured label coordinates
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const path = require('path');
const { fetchMetadata } = require('../../utils/fetchMetadata');

async function buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath) {
  const canvas = createCanvas(600, 600);
  const ctx = canvas.getContext('2d');

  try {
    const meta = await fetchMetadata(contractAddress, tokenId, chain);
    const localPlaceholder = path.resolve(__dirname, '../../assets/placeholders/nft-placeholder.png');
    const nftImage = await loadImage(meta.image_fixed || meta.image || localPlaceholder);
    const floppyImage = await loadImage(floppyPath);
    const qrImage = await loadImage('https://api.qrserver.com/v1/create-qr-code/?size=90x90&data=' + encodeURIComponent(meta.permalink || `https://basescan.org/token/${contractAddress}?a=${tokenId}`));

    ctx.drawImage(floppyImage, 0, 0, 600, 600);
    ctx.drawImage(nftImage, 100, 50, 260, 260); // Bigger NFT top left inside label
    ctx.drawImage(qrImage, 395, 260, 85, 85); // QR bottom right inside label

    ctx.font = 'bold 18px Arial';
    ctx.fillStyle = '#111';
    ctx.fillText(`${collectionName}`, 250, 140); // Higher name & ID top right
    ctx.fillText(`ID #${tokenId}`, 250, 170);
    ctx.fillText(`Rank: ${meta.rank || 'N/A'}`, 250, 200);

    ctx.font = 'bold 16px Arial';
    ctx.fillText(`Minted with $ADRIAN on Base`, 65, 290); // Under NFT image
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




