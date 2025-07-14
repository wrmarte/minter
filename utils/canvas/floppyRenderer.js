// ✅ utils/canvas/floppyRenderer.js with FlexCard-style text and shadow setup
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const { fetchMetadata } = require('../../utils/fetchMetadata');

const fontPath = path.join(__dirname, '../../fonts/Exo2-Bold.ttf');
GlobalFonts.registerFromPath(fontPath, 'Exo2');

async function buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath) {
  const canvas = createCanvas(600, 600);
  const ctx = canvas.getContext('2d');

  try {
    const meta = await fetchMetadata(contractAddress, tokenId, chain);
    const localPlaceholder = path.resolve(__dirname, '../../assets/placeholders/nft-placeholder.png');
    const nftImage = await loadImage(meta.image_fixed || meta.image || localPlaceholder);
    const floppyImage = await loadImage(floppyPath);
    const qrImage = await loadImage(`https://api.qrserver.com/v1/create-qr-code/?size=90x90&bgcolor=255-255-255-0&data=${encodeURIComponent(meta.permalink || `https://basescan.org/token/${contractAddress}?a=${tokenId}`)}`);

    ctx.drawImage(floppyImage, 0, 0, 600, 600);
    ctx.drawImage(nftImage, 100, 50, 300, 300);
    ctx.drawImage(qrImage, 50, 400, 85, 85);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = '#000000';

    ctx.font = 'bold 22px Exo2';
    ctx.textAlign = 'left';
    ctx.fillText(`${collectionName}`, 250, 100);
    ctx.fillText(`ID #${tokenId}`, 250, 130);
    ctx.fillText(`Rank: ${meta.rank || 'N/A'}`, 250, 160);

    ctx.font = 'bold 18px Exo2';
    ctx.fillText(`Minted with $ADRIAN on Base`, 100, 330);
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






