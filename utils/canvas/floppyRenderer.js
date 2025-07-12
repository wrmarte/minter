// floppyRenderer.js
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const QRCode = require('qrcode');

async function buildFloppyFlexRenderer({ image, traits, tokenId, collectionName, opensea_url, rank }) {
  const canvas = createCanvas(512, 512);
  const ctx = canvas.getContext('2d');

  const floppyBase = await loadImage('./assets/floppy_base.png');
  ctx.drawImage(floppyBase, 0, 0, 512, 512);

  try {
    const nftImage = await loadImage(image);
    ctx.drawImage(nftImage, 120, 150, 270, 270);
  } catch (err) {
    console.warn('❌ Failed to load NFT image:', err.message);
  }

  ctx.font = '16px monospace';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`Rank: ${rank}`, 20, 40);
  ctx.fillText(`ID: ${tokenId}`, 20, 60);
  ctx.fillText(collectionName, 20, 80);

  traits.slice(0, 3).forEach((trait, i) => {
    ctx.fillText(`${trait.trait_type || trait.type || 'Trait'}: ${trait.value}`, 20, 110 + i * 20);
  });

  const qrCanvas = createCanvas(100, 100);
  await QRCode.toCanvas(qrCanvas, opensea_url || 'https://opensea.io', { margin: 0 });
  ctx.drawImage(qrCanvas, 400, 400, 90, 90);

  return canvas.toBuffer('image/png');
}

module.exports = { buildFloppyFlexRenderer };
