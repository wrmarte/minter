const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const path = require('path');

// Register font
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
  score,
  mintedDate,
  network,
  totalSupply
}) {
  const width = 1124;
  const height = 1650;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const margin = 40;
  const usableWidth = width - 2 * margin;
  const titleHeight = 120;
  const footerHeight = 30;
  const ownerWidth = 140;
  const traitsHeaderHeight = 60;
  const qrSize = 220;
  const qrPadding = 20;
  const nftSize = 680;
  const traitsHeight = 340;
  const metaHeaderHeight = 60;
  const metaHeight = qrSize - 10 - metaHeaderHeight;

  const olive = '#4e7442';
  const forest = '#294f30';

  // Background
  ctx.fillStyle = olive;
  ctx.fillRect(0, 0, width, height);

  // Outer border
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.strokeRect(margin, margin, usableWidth, height - 2 * margin);

  // Title
  ctx.fillStyle = forest;
  ctx.fillRect(margin, margin, usableWidth, titleHeight);
  ctx.strokeRect(margin, margin, usableWidth, titleHeight);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 38px Exo2';
  ctx.textAlign = 'left';
  ctx.fillText((collectionName || 'NFT').toUpperCase(), margin + 20, margin + 70);
  ctx.textAlign = 'right';
  ctx.fillText(`#${tokenId}`, margin + usableWidth - 20, margin + 70);

  // NFT
  const nftX = margin + (usableWidth - ownerWidth - nftSize) / 2;
  const nftY = margin + titleHeight + 40;
  ctx.fillStyle = olive;
  ctx.fillRect(nftX, nftY, nftSize, nftSize);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(nftX, nftY, nftSize, nftSize);

  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, nftX, nftY, nftSize, nftSize);

  // Owner section
  const ownerX = width - margin - ownerWidth;
  const ownerY = margin + titleHeight;
  const ownerHeight = height - ownerY - footerHeight;
  ctx.fillStyle = forest;
  ctx.fillRect(ownerX, ownerY, ownerWidth, ownerHeight);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(ownerX, ownerY, ownerWidth, ownerHeight);
  ctx.save();
  ctx.translate(ownerX + ownerWidth / 2, ownerY + ownerHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 42px Exo2';
  ctx.textAlign = 'center';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 0, 10);
  ctx.restore();

  // Traits header
  const traitsHeaderY = nftY + nftSize + 40;
  ctx.fillStyle = forest;
  ctx.fillRect(margin, traitsHeaderY, usableWidth - ownerWidth, traitsHeaderHeight);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(margin, traitsHeaderY, usableWidth - ownerWidth, traitsHeaderHeight);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 28px Exo2';
  ctx.textAlign = 'left';
  ctx.fillText('TRAITS', margin + 20, traitsHeaderY + traitsHeaderHeight / 2 + 8);

  // Traits block
  const traitsY = traitsHeaderY + traitsHeaderHeight;
  ctx.fillStyle = olive;
  ctx.fillRect(margin, traitsY, usableWidth - ownerWidth, traitsHeight);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(margin, traitsY, usableWidth - ownerWidth, traitsHeight);

  ctx.fillStyle = 'white';
  ctx.font = '22px Exo2';
  ctx.textAlign = 'left';
  let traitY = traitsY + 36;
  for (const trait of traits.slice(0, 12)) {
    ctx.fillText(`• ${trait}`, margin + 20, traitY);
    traitY += 30;
  }

  // Trait count box
  const traitCountX = margin + usableWidth - ownerWidth - 60;
  const traitCountY = traitsY + traitsHeight - 50;
  ctx.font = 'bold 38px Exo2';
  ctx.fillText(`${traits.length}`, traitCountX, traitCountY);

  // Metadata header
  const metaHeaderY = traitsY + traitsHeight + 10;
  ctx.fillStyle = forest;
  ctx.fillRect(margin, metaHeaderY, usableWidth, metaHeaderHeight);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(margin, metaHeaderY, usableWidth, metaHeaderHeight);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 28px Exo2';
  ctx.fillText('METADATA', margin + 20, metaHeaderY + metaHeaderHeight / 2 + 8);

  // Metadata block
  const metaY = metaHeaderY + metaHeaderHeight;
  ctx.fillStyle = olive;
  ctx.fillRect(margin, metaY, usableWidth - ownerWidth, metaHeight);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(margin, metaY, usableWidth - ownerWidth, metaHeight);

  const mintedDisplay = (typeof mintedDate === 'string' && mintedDate.length >= 10)
    ? mintedDate
    : '❌ Not Found';

  const metaLines = [
    `• Rank: ${rank ?? 'N/A'}`,
    `• Score: ${score ?? '—'}`,
    `• Minted: ${mintedDisplay}`,
    `• Network: ${network ?? 'Base'}`,
    `• Total Supply: ${totalSupply ?? 'N/A'}`
  ];

  ctx.fillStyle = 'white';
  ctx.font = '22px Exo2';
  const metaStartY = metaY + 30;
  for (let i = 0; i < metaLines.length; i++) {
    ctx.fillText(metaLines[i], margin + 20, metaStartY + i * 28);
  }

  // QR Code block
  const qrX = width - margin - qrSize;
  const qrY = height - margin - footerHeight - qrSize + 20;
  ctx.fillStyle = 'white';
  ctx.fillRect(qrX, qrY, qrSize, qrSize);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(qrX, qrY, qrSize, qrSize);

  const qrBuffer = await QRCode.toBuffer(openseaUrl, {
    width: qrSize - 2 * qrPadding,
    margin: 1
  });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, qrX + qrPadding, qrY + qrPadding, qrSize - 2 * qrPadding, qrSize - 2 * qrPadding);

  // Footer
  const footerY = height - margin - footerHeight;
  ctx.fillStyle = forest;
  ctx.fillRect(margin, footerY, usableWidth, footerHeight);
  ctx.strokeStyle = 'white';
  ctx.strokeRect(margin, footerY, usableWidth, footerHeight);
  ctx.fillStyle = 'white';
  ctx.font = 'bold 24px Exo2';
  ctx.textAlign = 'center';
  ctx.fillText('Powered by PimpsDev 🚀', width / 2, footerY + 24);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };









