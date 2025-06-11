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
  openseaUrl,
  rank,
  mintedDate,
  network,
  totalSupply
}) {
  const width = 1124;
  const height = 1650;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Constants
  const margin = 40;
  const usableWidth = width - 2 * margin;
  const titleHeight = 120;
  const footerHeight = 40;
  const ownerWidth = 140;
  const traitsHeaderHeight = 60;
  const qrSize = 300;
  const qrPadding = 20;
  const nftSize = 680;

  const olive = '#4e7442';
  const forest = '#294f30';

  // Fill background
  ctx.fillStyle = olive;
  ctx.fillRect(0, 0, width, height);

  // Outer border
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.strokeRect(margin, margin, usableWidth, height - 2 * margin);

  // Title bar
  ctx.fillStyle = forest;
  ctx.fillRect(margin, margin, usableWidth, titleHeight);
  ctx.strokeRect(margin, margin, usableWidth, titleHeight);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 38px Exo2';
  ctx.textAlign = 'left';
  ctx.fillText((collectionName || 'NFT').toUpperCase(), margin + 20, margin + 70);
  ctx.textAlign = 'right';
  ctx.fillText(`#${tokenId}`, margin + usableWidth - 20, margin + 70);

  // NFT image
  const nftX = margin + (usableWidth - ownerWidth - nftSize) / 2;
  const nftY = margin + titleHeight + 40;
  ctx.fillStyle = olive;
  ctx.fillRect(nftX, nftY, nftSize, nftSize);
  ctx.strokeRect(nftX, nftY, nftSize, nftSize);

  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, nftX, nftY, nftSize, nftSize);

  // Owner section (vertical)
  const ownerX = width - margin - ownerWidth;
  const ownerY = margin + titleHeight;
  const ownerHeight = height - ownerY - qrSize - footerHeight - 40;
  ctx.fillStyle = forest;
  ctx.fillRect(ownerX, ownerY, ownerWidth, ownerHeight);
  ctx.strokeRect(ownerX, ownerY, ownerWidth, ownerHeight);
  ctx.save();
  ctx.translate(ownerX + ownerWidth / 2, ownerY + ownerHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 42px Exo2';
  ctx.textAlign = 'center';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 0, 10);
  ctx.restore();

  // Traits Header
  const traitsHeaderY = nftY + nftSize + 40;
  const traitsHeaderWidth = usableWidth - ownerWidth;
  ctx.fillStyle = forest;
  ctx.fillRect(margin, traitsHeaderY, traitsHeaderWidth, traitsHeaderHeight);
  ctx.strokeRect(margin, traitsHeaderY, traitsHeaderWidth, traitsHeaderHeight);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 28px Exo2';
  ctx.textAlign = 'left';
  ctx.fillText('TRAITS', margin + 20, traitsHeaderY + traitsHeaderHeight / 2 + 8);

  // Traits Info zone (expanded, no bottom border)
  const traitsY = traitsHeaderY + traitsHeaderHeight;
  const traitsHeight = 220;
  ctx.fillStyle = olive;
  ctx.fillRect(margin, traitsY, traitsHeaderWidth, traitsHeight);
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(margin, traitsY);
  ctx.lineTo(margin, traitsY + traitsHeight);
  ctx.lineTo(margin + traitsHeaderWidth, traitsY + traitsHeight);
  ctx.lineTo(margin + traitsHeaderWidth, traitsY);
  ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = 'white';
  ctx.font = '22px Exo2';
  let traitY = traitsY + 36;
  for (const trait of traits) {
    ctx.fillText(`• ${trait}`, margin + 20, traitY);
    traitY += 30;
  }

  // QR code zone
  const qrX = width - margin - qrSize;
  const qrY = height - margin - qrSize - footerHeight;
  ctx.fillStyle = 'white';
  ctx.fillRect(qrX, qrY, qrSize, qrSize);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(qrX, qrY, qrSize, qrSize);

  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: qrSize - 2 * qrPadding, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, qrX + qrPadding, qrY + qrPadding, qrSize - 2 * qrPadding, qrSize - 2 * qrPadding);

  // Metadata zone
  const metaY = traitsY + traitsHeight + 10;
  const metaHeight = qrSize - 20;
  const metaX = margin;
  const metaWidth = usableWidth - qrSize - 20;
  ctx.fillStyle = olive;
  ctx.fillRect(metaX, metaY, metaWidth, metaHeight);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(metaX, metaY, metaWidth, metaHeight);

  const metaLines = [
    `• Rank: ${rank || 'N/A'}`,
    `• Minted: ${mintedDate || 'Unknown'}`,
    `• Network: ${network || 'Base'}`,
    `• Total Supply: ${totalSupply || 'N/A'}`
  ];
  ctx.fillStyle = 'white';
  ctx.font = '22px Exo2';
  ctx.textAlign = 'left';
  const metaStartY = metaY + (metaHeight - metaLines.length * 28) / 2 + 4;
  for (let i = 0; i < metaLines.length; i++) {
    ctx.fillText(metaLines[i], metaX + 20, metaStartY + i * 28);
  }

  // Footer
  const footerY = height - margin - footerHeight;
  ctx.fillStyle = forest;
  ctx.fillRect(margin, footerY, usableWidth, footerHeight);
  ctx.strokeRect(margin, footerY, usableWidth, footerHeight);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 24px Exo2';
  ctx.textAlign = 'center';
  ctx.fillText('Powered by PimpsDev 🚀', width / 2, footerY + 28);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };















