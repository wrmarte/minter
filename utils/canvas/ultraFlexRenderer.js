const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const path = require('path');

// Register font globally
const fontPath = path.join(__dirname, '../../fonts/Exo2-Bold.ttf');
GlobalFonts.registerFromPath(fontPath, 'Exo2');

async function generateUltraFlexCard({
  nftImageUrl,
  collectionName,
  tokenId,
  traits,
  owner,
  openseaUrl
}) {
  const width = 2048;
  const height = 3072;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // GOLDEN GRADIENT BACKGROUND
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#FFD700');
  gradient.addColorStop(1, '#FFA500');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Draw NFT Image with subtle glow-style border
  const nftImg = await loadImage(nftImageUrl);
  const imgX = 275;
  const imgY = 250;
  const imgSize = 1500;

  // Glow border effect
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(imgX - 15, imgY - 15, imgSize + 30, imgSize + 30, 50);
  ctx.clip();
  ctx.fillStyle = '#fff';
  ctx.shadowColor = '#FFD700';
  ctx.shadowBlur = 60;
  ctx.fillRect(imgX - 15, imgY - 15, imgSize + 30, imgSize + 30);
  ctx.restore();

  ctx.drawImage(nftImg, imgX, imgY, imgSize, imgSize);

  // Title Bar
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 1800, width, 100);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 90px Exo2';
  ctx.fillText(`${(collectionName || "NFT").toUpperCase()} #${tokenId}`, 80, 1870);

  // Traits Box
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 1950, width, 700);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 70px Exo2';
  ctx.fillText('TRAITS', 80, 2030);

  const maxTraits = 12;
  const displayedTraits = traits.slice(0, maxTraits);
  ctx.font = '60px Exo2';
  let traitY = 2120;
  for (const trait of displayedTraits) {
    ctx.fillText(`${trait}`, 80, traitY);
    traitY += 70;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, 80, traitY);
  }

  // QR Code
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: 600, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, width - 700, 2050, 500, 500);

  // Owner Box
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 2700, width, 80);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 60px Exo2';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 80, 2760);

  // Footer Branding (Ultra Signature)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 2800, width, 60);
  ctx.fillStyle = '#FFD700';
  ctx.font = 'bold 50px Exo2';
  const footerText = 'ULTRA FLEXCARD ✨ Powered by PimpsDev';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, (width - textWidth) / 2, 2850);

  return canvas.toBuffer('image/png');
}

module.exports = { generateUltraFlexCard };

