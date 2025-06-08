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

  // TRUE CENTERED NFT IMAGE
  const nftImg = await loadImage(nftImageUrl);
  const imgSize = 1750;
  const imgX = (width - imgSize) / 2;
  const imgY = 120;

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
  ctx.textBaseline = 'middle';
  ctx.fillText(`${(collectionName || "NFT").toUpperCase()} #${tokenId}`, 80, 2000 + 50);

  // GOLD Divider
  ctx.fillStyle = '#FFD700';
  ctx.fillRect(0, 2100, width, 10);

  // Unified Traits & QR Zone
  const traitsBoxTop = 2110;
  const traitsBoxBottom = 2800;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, traitsBoxTop, width, traitsBoxBottom - traitsBoxTop);

  // TRAITS Title as first row
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 70px Exo2';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('TRAITS', 80, traitsBoxTop + 70);

  // Traits List (max 7)
  const maxTraits = 7;
  const displayedTraits = traits.slice(0, maxTraits);
  ctx.font = '60px Exo2';
  let traitY = traitsBoxTop + 150;
  for (const trait of displayedTraits) {
    ctx.fillText(`${trait}`, 80, traitY);
    traitY += 70;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, 80, traitY);
  }

  // QR Code — perfectly centered within traits zone
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: 600, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  const qrSize = 500;
  const qrY = traitsBoxTop + ((traitsBoxBottom - traitsBoxTop - qrSize) / 2);
  ctx.drawImage(qrImg, width - 700, qrY, qrSize, qrSize);

  // GOLD Divider before Owner Box
  ctx.fillStyle = '#FFD700';
  ctx.fillRect(0, 2800, width, 10);

  // Owner Box (fully centered text)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 2810, width, 80);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 60px Exo2';
  ctx.textBaseline = 'middle';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 80, 2810 + 40);

  // Footer Branding (perfect vertical center)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 2920, width, 60);
  ctx.fillStyle = '#FFD700';
  ctx.font = 'bold 50px Exo2';
  ctx.textBaseline = 'middle';
  ctx.fillText('ULTRA FLEXCARD ✨ Powered by PimpsDev', width / 2 - ctx.measureText('ULTRA FLEXCARD ✨ Powered by PimpsDev').width / 2, 2920 + 30);

  return canvas.toBuffer('image/png');
}

module.exports = { generateUltraFlexCard };




