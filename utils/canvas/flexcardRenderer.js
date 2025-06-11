const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
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

  // Layout constants
  const margin = 40;
  const usableWidth = width - margin * 2;
  const titleHeight = 120;
  const footerHeight = 40;
  const ownerWidth = 140;
  const traitsHeaderHeight = 60;
  const traitsInfoHeight = 240;
  const qrZoneWidth = 300;
  const qrZoneHeight = 300;

  const contentRight = width - margin - ownerWidth;
  const contentWidth = contentRight - margin;

  // Background
  ctx.fillStyle = '#31613D';
  ctx.fillRect(0, 0, width, height);

  // Outer border
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.strokeRect(margin, margin, usableWidth, height - 2 * margin);

  // Title bar
  ctx.fillStyle = 'black';
  ctx.fillRect(margin, margin, usableWidth, titleHeight);
  ctx.strokeRect(margin, margin, usableWidth, titleHeight);

  ctx.fillStyle = 'white';
  ctx.font = 'bold 42px Exo2';
  ctx.fillText((collectionName || 'NFT').toUpperCase(), margin + 40, margin + titleHeight / 2 + 15);
  ctx.textAlign = 'right';
  ctx.fillText(`#${tokenId}`, contentRight - 20, margin + titleHeight / 2 + 15);
  ctx.textAlign = 'left';

  // Footer
  const footerY = height - margin - footerHeight;
  ctx.fillStyle = 'black';
  ctx.fillRect(margin, footerY, usableWidth, footerHeight);
  ctx.strokeRect(margin, footerY, usableWidth, footerHeight);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 24px Exo2';
  const footerText = 'Powered by PimpsDev 🚀';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, (width - textWidth) / 2, footerY + footerHeight / 2 + 8);

  // QR block
  const qrZoneX = width - margin - qrZoneWidth;
  const qrZoneY = footerY - qrZoneHeight;
  ctx.fillStyle = 'white';
  ctx.fillRect(qrZoneX, qrZoneY, qrZoneWidth, qrZoneHeight);

  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: 256, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  const qrPadding = 20;
  const qrSize = qrZoneWidth - qrPadding * 2;
  ctx.drawImage(qrImg, qrZoneX + qrPadding, qrZoneY + qrPadding, qrSize, qrSize);

  // Owner strip
  const ownerY = margin + titleHeight;
  const ownerH = qrZoneY - ownerY;
  const ownerX = width - margin - ownerWidth;
  ctx.strokeRect(ownerX, ownerY, ownerWidth, ownerH);
  ctx.save();
  ctx.translate(ownerX + ownerWidth / 2, ownerY + ownerH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 36px Exo2';
  ctx.fillStyle = 'white';
  ctx.textAlign = 'center';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 0, 0);
  ctx.restore();

  // Traits
  const traitsHeaderY = qrZoneY - traitsHeaderHeight - traitsInfoHeight;
  ctx.fillStyle = 'black';
  ctx.fillRect(margin, traitsHeaderY, contentWidth, traitsHeaderHeight);
  ctx.strokeRect(margin, traitsHeaderY, contentWidth, traitsHeaderHeight);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 28px Exo2';
  ctx.fillText('TRAITS', margin + 20, traitsHeaderY + traitsHeaderHeight / 2 + 10);

  const traitsInfoY = traitsHeaderY + traitsHeaderHeight;
  ctx.fillStyle = '#31613D';
  ctx.fillRect(margin, traitsInfoY, contentWidth, traitsInfoHeight);

  ctx.fillStyle = 'white';
  ctx.font = '24px Exo2';
  const maxTraits = traits.length;
  const lineHeight = 32;
  let traitY = traitsInfoY + 36;
  for (let i = 0; i < maxTraits; i++) {
    ctx.fillText(`• ${traits[i]}`, margin + 20, traitY);
    traitY += lineHeight;
  }

  // NFT Image centered block
  const nftZoneTop = margin + titleHeight;
  const nftZoneBottom = traitsHeaderY - 40;
  const nftZoneHeight = nftZoneBottom - nftZoneTop;
  const nftWidth = contentWidth - 160;
  const nftHeight = 800;
  const nftX = margin + (contentWidth - nftWidth) / 2;
  const nftY = nftZoneTop + (nftZoneHeight - nftHeight) / 2;

  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, nftX, nftY, nftWidth, nftHeight);
  ctx.strokeRect(nftX, nftY, nftWidth, nftHeight);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };











