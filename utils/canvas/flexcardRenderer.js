const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Register font globally
const fontPath = path.join(__dirname, '../../fonts/Exo2-Bold.ttf');
GlobalFonts.registerFromPath(fontPath, 'Exo2');

async function generateFlexCard({
  nftImageUrl,
  collectionName,
  tokenId,
  traits,
  owner,
  openseaUrl
}) {
  const width = 1124;
  const height = 1650;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#7AA547';
  ctx.fillRect(0, 0, width, height);

  // Outer border
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(20, 20, width - 40, height - 40);

  // Title Bar
  ctx.fillStyle = '#000';
  ctx.fillRect(40, 40, width - 80, 80);
  ctx.strokeRect(40, 40, width - 80, 80);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 42px Exo2';
  ctx.fillText(`${(collectionName || 'NFT').toUpperCase()} #${tokenId}`, 60, 95);

  // Load NFT image
  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, 112, 140, 900, 900);
  ctx.strokeRect(112, 140, 900, 900);

  // Owner vertical tag
  ctx.save();
  ctx.translate(width - 40, 600);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 40px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 0, 0);
  ctx.restore();

  // Traits Section
  ctx.fillStyle = '#000';
  ctx.fillRect(40, 1060, width - 80, 380);
  ctx.strokeRect(40, 1060, width - 80, 380);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 32px Exo2';
  ctx.fillText('TRAITS', 60, 1105);

  const maxTraits = 7;
  const displayedTraits = traits.slice(0, maxTraits);
  ctx.font = '28px Exo2';
  let traitY = 1150;
  for (const trait of displayedTraits) {
    ctx.fillText(`${trait}`, 60, traitY);
    traitY += 36;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, 60, traitY);
  }

  // QR Code
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: 300, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, width - 320, 1370, 260, 260);

  // Footer Branding
  ctx.fillStyle = '#000';
  ctx.fillRect(40, height - 60, width - 80, 40);
  ctx.strokeRect(40, height - 60, width - 80, 40);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 24px Exo2';
  const footerText = 'Powered by PimpsDev 🚀';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, (width - textWidth) / 2, height - 30);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };






