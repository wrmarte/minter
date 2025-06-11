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

  // Constants
  const margin = 40;
  const titleHeight = 120;
  const footerHeight = 40;
  const ownerWidth = 140;
  const traitsHeaderHeight = 60;
  const traitsInfoHeight = 560;
  const qrZoneSize = 300;
  const usableWidth = width - margin * 2;

  // Background
  ctx.fillStyle = '#31613D';
  ctx.fillRect(0, 0, width, height);

  // Outer border
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#FFFFFF';
  ctx.strokeRect(margin, margin, usableWidth, height - 2 * margin);

  // Title bar
  ctx.fillStyle = '#000';
  ctx.fillRect(margin, margin, usableWidth, titleHeight);
  ctx.strokeRect(margin, margin, usableWidth, titleHeight);

  ctx.font = 'bold 42px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText((collectionName || 'NFT').toUpperCase(), margin + 20, margin + 70);
  ctx.textAlign = 'right';
  ctx.fillText(`#${tokenId}`, width - margin - 20, margin + 70);
  ctx.textAlign = 'left';

  // Footer
  const footerY = height - margin - footerHeight;
  ctx.fillStyle = '#000';
  ctx.fillRect(margin, footerY, usableWidth, footerHeight);
  ctx.strokeRect(margin, footerY, usableWidth, footerHeight);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 24px Exo2';
  const footerText = 'Powered by PimpsDev 🚀';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, (width - textWidth) / 2, footerY + 28);

  // QR Code
  const qrZoneX = width - margin - qrZoneSize;
  const qrZoneY = footerY - qrZoneSize;
  ctx.fillStyle = '#fff';
  ctx.fillRect(qrZoneX, qrZoneY, qrZoneSize, qrZoneSize);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(qrZoneX, qrZoneY, qrZoneSize, qrZoneSize);

  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: 256, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, qrZoneX + 22, qrZoneY + 22, 256, 256);

  // Owner vertical strip
  const ownerY = margin + titleHeight;
  const ownerHeight = qrZoneY - ownerY;
  const ownerX = width - margin - ownerWidth;
  ctx.strokeRect(ownerX, ownerY, ownerWidth, ownerHeight);
  ctx.save();
  ctx.translate(ownerX + ownerWidth / 2, ownerY + ownerHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 46px Exo2';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 0, 16);
  ctx.restore();

  // Traits header
  const traitsHeaderY = qrZoneY - traitsHeaderHeight - traitsInfoHeight;
  ctx.fillStyle = '#000';
  ctx.fillRect(margin, traitsHeaderY, usableWidth - ownerWidth, traitsHeaderHeight);
  ctx.strokeRect(margin, traitsHeaderY, usableWidth - ownerWidth, traitsHeaderHeight);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 28px Exo2';
  ctx.fillText('TRAITS', margin + 20, traitsHeaderY + 42);

  // Traits info zone
  const traitsInfoY = traitsHeaderY + traitsHeaderHeight;
  const traitsInfoWidth = usableWidth - ownerWidth;
  ctx.fillStyle = '#294f30';
  ctx.fillRect(margin, traitsInfoY, traitsInfoWidth, traitsInfoHeight);
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(margin, traitsInfoY);
  ctx.lineTo(margin, traitsInfoY + traitsInfoHeight);
  ctx.lineTo(margin + traitsInfoWidth, traitsInfoY + traitsInfoHeight);
  ctx.lineTo(margin + traitsInfoWidth, traitsInfoY);
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = '20px Exo2';
  const maxTraits = 14;
  const displayedTraits = traits.slice(0, maxTraits);
  let traitY = traitsInfoY + 32;
  for (const trait of displayedTraits) {
    ctx.fillText(`• ${trait}`, margin + 20, traitY);
    traitY += 34;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, margin + 20, traitY);
  }

  // NFT Image Zone
  const nftZoneTop = margin + titleHeight + 40;
  const nftZoneBottom = traitsHeaderY - 40;
  const nftZoneHeight = nftZoneBottom - nftZoneTop;
  const nftSize = 700; // perfect square
  const nftX = margin + ((usableWidth - ownerWidth - nftSize) / 2);
  const nftY = nftZoneTop + ((nftZoneHeight - nftSize) / 2);

  ctx.strokeRect(nftX, nftY, nftSize, nftSize);
  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, nftX, nftY, nftSize, nftSize);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };












