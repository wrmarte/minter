const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

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
  ctx.fillStyle = '#31613D';
  ctx.fillRect(0, 0, width, height);

  // Outer border
  const margin = 40;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(margin, margin, width - 2 * margin, height - 2 * margin);

  const usableWidth = width - 2 * margin;
  const ownerWidth = 140;
  const contentRight = width - margin - ownerWidth;
  const contentWidth = contentRight - margin;

  // Title bar
  const titleHeight = 120;
  ctx.fillStyle = '#000';
  ctx.fillRect(margin, margin, usableWidth, titleHeight);
  ctx.strokeRect(margin, margin, usableWidth, titleHeight);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 42px Exo2';
  ctx.textAlign = 'left';
  ctx.fillText((collectionName || 'NFT').toUpperCase(), margin + 20, margin + titleHeight / 2 + 15);
  ctx.textAlign = 'right';
  ctx.fillText(`#${tokenId}`, width - margin - 20, margin + titleHeight / 2 + 15);

  // Footer bar
  const footerHeight = 40;
  const footerY = height - margin - footerHeight;
  ctx.fillStyle = '#000';
  ctx.fillRect(margin, footerY, usableWidth, footerHeight);
  ctx.strokeRect(margin, footerY, usableWidth, footerHeight);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 24px Exo2';
  ctx.textAlign = 'center';
  ctx.fillText('Powered by PimpsDev 🚀', width / 2, footerY + footerHeight / 2 + 8);

  // QR Zone
  const qrZoneW = 300;
  const qrZoneH = 300;
  const qrZoneX = width - margin - qrZoneW;
  const qrZoneY = footerY - qrZoneH;
  ctx.fillStyle = '#fff';
  ctx.fillRect(qrZoneX, qrZoneY, qrZoneW, qrZoneH);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(qrZoneX, qrZoneY, qrZoneW, qrZoneH);

  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: 300, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  const qrPadding = 20;
  ctx.drawImage(qrImg, qrZoneX + qrPadding, qrZoneY + qrPadding, qrZoneW - 2 * qrPadding, qrZoneH - 2 * qrPadding);

  // Owner strip
  const ownerY = margin + titleHeight;
  const ownerH = qrZoneY - ownerY;
  const ownerX = width - margin - ownerWidth;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(ownerX, ownerY, ownerWidth, ownerH);
  ctx.save();
  ctx.translate(ownerX + ownerWidth / 2, ownerY + ownerH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 48px Exo2';
  ctx.textAlign = 'center';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 0, 10);
  ctx.restore();

  // Traits section
  const traitsHeaderHeight = 60;
  const traitsInfoHeight = 280;
  const traitsHeaderY = qrZoneY - traitsHeaderHeight - traitsInfoHeight;
  const traitsInfoY = traitsHeaderY + traitsHeaderHeight;

  // Traits header
  ctx.fillStyle = '#000';
  ctx.fillRect(margin, traitsHeaderY, contentWidth, traitsHeaderHeight);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(margin, traitsHeaderY, contentWidth, traitsHeaderHeight);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 28px Exo2';
  ctx.textAlign = 'left';
  ctx.fillText('TRAITS', margin + 20, traitsHeaderY + traitsHeaderHeight / 2 + 10);

  // Traits info box (with reinforced left, right, top borders only)
  ctx.fillStyle = '#31613D';
  ctx.fillRect(margin, traitsInfoY, contentWidth, traitsInfoHeight);
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(margin, traitsInfoY);
  ctx.lineTo(margin + contentWidth, traitsInfoY);
  ctx.moveTo(margin, traitsInfoY);
  ctx.lineTo(margin, traitsInfoY + traitsInfoHeight);
  ctx.moveTo(margin + contentWidth, traitsInfoY);
  ctx.lineTo(margin + contentWidth, traitsInfoY + traitsInfoHeight);
  ctx.stroke();

  // Render traits
  ctx.fillStyle = '#fff';
  ctx.font = '24px Exo2';
  ctx.textAlign = 'left';
  let traitY = traitsInfoY + 36;
  const maxTraits = 9;
  const displayedTraits = traits.slice(0, maxTraits);
  for (const trait of displayedTraits) {
    ctx.fillText(`• ${trait}`, margin + 20, traitY);
    traitY += 32;
  }

  // NFT image
  const nftZoneTop = margin + titleHeight + 40;
  const nftZoneBottom = traitsHeaderY - 40;
  const nftZoneHeight = nftZoneBottom - nftZoneTop;
  const nftWidth = contentWidth - 100;
  const nftHeight = nftZoneHeight * 0.92;
  const nftX = margin + (contentWidth - nftWidth) / 2;
  const nftY = nftZoneTop + (nftZoneHeight - nftHeight) / 2;

  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, nftX, nftY, nftWidth, nftHeight);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(nftX, nftY, nftWidth, nftHeight);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };











