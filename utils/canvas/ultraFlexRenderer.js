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

  // BIGGEST NFT IMAGE - almost full canvas height now
  const nftImg = await loadImage(nftImageUrl);
  const imgX = 100;
  const imgY = 50;
  const imgSize = 1850;

  // Glow border effect
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(imgX - 10, imgY - 10, imgSize + 20, imgSize + 20, 50);
  ctx.clip();
  ctx.fillStyle = '#fff';
  ctx.shadowColor = '#FFD700';
  ctx.shadowBlur = 50;
  ctx.fillRect(imgX - 10, imgY - 10, imgSize + 20, imgSize + 20);
  ctx.restore();

  ctx.drawImage(nftImg, imgX, imgY, imgSize, imgSize);

  // Title Bar
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 2000, width, 100);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 90px Exo2';
  ctx.fillText(`${(collectionName || "NFT").toUpperCase()} #${tokenId}`, 80, 2070);

  // GOLD Divider
  ctx.fillStyle = '#FFD700';
  ctx.fillRect(0, 2100, width, 10);

  // Traits Box
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 2110, width, 600);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 70px Exo2';
  ctx.fillText('TRAITS', 80, 2180);

  const maxTraits = 12;
  const displayedTraits = traits.slice(0, maxTraits);
  ctx.font = '60px Exo2';
  let traitY = 2270;
  for (const trait of displayedTraits) {
    ctx.fillText(`${trait}`, 80, traitY);
    traitY += 70;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, 80, traitY);
  }

  // QR Code (with breathing space from bottom)
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: 600, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, width - 700, 2200, 500, 500);

  // Owner Box
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 2800, width, 80);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 60px Exo2';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 80, 2860);

  // Footer Branding (Ultra Signature)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 2920, width, 60);
  ctx.fillStyle = '#FFD700';
  ctx.font = 'bold 50px Exo2';
  const footerText = 'ULTRA FLEXCARD ✨ Powered by PimpsDev';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, (width - textWidth) / 2, 2970);

  return canvas.toBuffer('image/png');
}

module.exports = { generateUltraFlexCard };




