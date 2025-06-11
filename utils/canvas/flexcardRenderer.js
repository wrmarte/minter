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

  // Load NFT image
  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, 112, 100, 900, 900);  // More centralized

  // Title Bar
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 1020, width, 60);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 36px Exo2';
  ctx.fillText(`${(collectionName || "NFT").toUpperCase()} #${tokenId}`, 50, 1065);

  // Traits Box
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 1100, width, 360);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 30px Exo2';
  ctx.fillText('TRAITS', 50, 1145);

  const maxTraits = 7;
  const displayedTraits = traits.slice(0, maxTraits);
  ctx.font = '28px Exo2';
  let traitY = 1190;
  for (const trait of displayedTraits) {
    ctx.fillText(`${trait}`, 50, traitY);
    traitY += 36;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, 50, traitY);
  }

  // QR Code (better aligned)
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: 300, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, width - 330, 1150, 260, 260);

  // Owner Bar
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 1480, width, 50);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 30px Exo2';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 50, 1515);

  // Footer Branding
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 1535, width, 40);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 24px Exo2';
  const footerText = 'Powered by PimpsDev 🚀';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, (width - textWidth) / 2, 1565);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };





