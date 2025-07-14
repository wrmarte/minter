// ✅ utils/canvas/floppyRenderer.js
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { fetchMetadata } = require('../../utils/fetchMetadata');
const { shortWalletLink } = require('../../utils/helpers');

async function buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath) {
  const canvas = createCanvas(600, 600);
  const ctx = canvas.getContext('2d');

  try {
    const meta = await fetchMetadata(contractAddress, tokenId, chain);
    const nftImage = await loadImage(meta.image_fixed || meta.image || 'https://via.placeholder.com/400x400.png?text=NFT');
    const floppyImage = await loadImage(floppyPath);

    ctx.drawImage(floppyImage, 0, 0, 600, 600);
    ctx.drawImage(nftImage, 120, 140, 360, 320);

    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${collectionName} #${tokenId}`, 30, 580);
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

