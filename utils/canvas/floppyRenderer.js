// ✅ utils/canvas/floppyRenderer.js with in-canvas transparent QR and inline metadata layout
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
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

    const qrCanvas = createCanvas(90, 90);
    await QRCode.toCanvas(qrCanvas, meta.permalink || `https://basescan.org/token/${contractAddress}?a=${tokenId}`, {
      margin: 1,
      color: {
        dark: '#000000',
        light: '#00000000'
      }
    });
    const qrImage = await loadImage(qrCanvas.toBuffer('image/png'));

    ctx.drawImage(floppyImage, 0, 0, 600, 600);
    ctx.drawImage(nftImage, 155, 50, 275, 275);
    ctx.drawImage(qrImage, 65, 480, 60, 60);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = '#000000';

    ctx.font = 'bold 20px Exo2';
    ctx.textAlign = 'left';
    const traitsArray = meta.traits?.length ? meta.traits : meta.attributes || [];
    const traitsCount = traitsArray.length;
    ctx.fillText(`${collectionName} #${tokenId} • Traits: ${traitsCount} • Rank: ${meta.rank}`, 100, 350);
    
    ctx.save();
    ctx.translate(500, 315);
    ctx.rotate(-Math.PI / 2);
    ctx.font = 'bold 18px Exo2';
    ctx.fillText(`Minted with $ADRIAN on Base`, 0, 0);
    ctx.restore();
  } catch (err) {
    console.warn('❌ buildFloppyCard error:', err);
    ctx.fillStyle = '#111';
    ctx.fillRect(20, 20, 600, 600);
    ctx.font = 'bold 30px Arial';
    ctx.fillStyle = '#fff';
    ctx.fillText('Error Loading NFT', 150, 300);
  }

  return canvas.toBuffer('image/png');
}

module.exports = {
  buildFloppyCard
};


























