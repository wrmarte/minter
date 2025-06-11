const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const path = require('path');

const fontPath = path.join(__dirname, '../../fonts/Exo2-Bold.ttf');
GlobalFonts.registerFromPath(fontPath, 'Exo2');

async function generateFlexCard({
  nftImageUrl,
  collectionName,
  tokenId,
  traits,
  owner,
  openseaUrl,
  rarityRank,
  mintDate,
  networkName,
  totalSupply
}) {
  const width = 1124;
  const height = 1650;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const margin = 40;
  const usableWidth = width - 2 * margin;
  const titleHeight = 120;
  const footerHeight = 40;
  const ownerWidth = 140;
  const traitsHeaderHeight = 60;
  const qrSize = 300;
  const qrPadding = 20;
  const nftSize = 620;
  const metaInfoHeight = 100;

  const olive = '#4e7442';
  const forest = '#294f30';

  ctx.fillStyle = olive;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;
  ctx.strokeRect(margin, margin, usableWidth, height - 2 * margin);

  // Title Bar
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
  ctx.strokeRect(nftX, nftY, nftSize, nftSize);

  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, nftX, nftY, nftSize, nftSize);

  // Owner Zone
  const ownerX = width - margin - ownerWidth;
  const ownerY = margin + titleHeight;
  const ownerHeight = height - margin - footerHeight - qrSize - ownerY;
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
  ctx.fillText('TRAITS', margin + 20, traitsHeaderY + 40);

  // Traits Info
  const traitsY = traitsHeaderY + traitsHeaderHeight;
  const traitsHeight = height - traitsY - qrSize - footerHeight - metaInfoHeight - 20;
  ctx.fillStyle = olive;
  ctx.fillRect(margin, traitsY, traitsHeaderWidth, traitsHeight);
  ctx.strokeStyle = 'white';
  ctx.beginPath();
  ctx.moveTo(margin, traitsY);
  ctx.lineTo(margin, traitsY + traitsHeight);
  ctx.lineTo(margin + traitsHeaderWidth, traitsY + traitsHeight);
  ctx.lineTo(margin + traitsHeaderWidth, traitsY);
  ctx.stroke();

  ctx.fillStyle = 'white';
  ctx.font = '22px Exo2';
  ctx.textAlign = 'left';
  let traitY = traitsY + 36;
  for (let i = 0; i < traits.length; i++) {
    ctx.fillText(`• ${traits[i]}`, margin + 20, traitY);
    traitY += 30;
  }

  // Metadata (Rank, Minted, Network, Total Supply)
  const metaY = traitsY + traitsHeight;
  const metaW = usableWidth - ownerWidth;
  ctx.fillStyle = olive;
  ctx.fillRect(margin, metaY, metaW, metaInfoHeight);
  ctx.strokeRect(margin, metaY, metaW, metaInfoHeight);

  const metaFont = '20px Exo2';
  ctx.font = metaFont;
  ctx.fillStyle = 'white';

  const labels = [
    [`Rank:`, `#${rarityRank ?? 'N/A'}`],
    [`Minted:`, mintDate ?? 'N/A'],
    [`Network:`, networkName ?? 'N/A'],
    [`Total Supply:`, totalSupply?.toString() ?? 'N/A']
  ];

  for (let i = 0; i < labels.length; i++) {
    const [label, value] = labels[i];
    const col = i % 2;
    const row = Math.floor(i / 2);
    const spacingX = metaW / 2;
    const x = margin + col * spacingX + 20;
    const y = metaY + 30 + row * 30;
    ctx.fillText(`${label} ${value}`, x, y);
  }

  // QR Code
  const qrX = width - margin - qrSize;
  const qrY = height - margin - qrSize - footerHeight;
  ctx.fillStyle = 'white';
  ctx.fillRect(qrX, qrY, qrSize, qrSize);
  ctx.strokeRect(qrX, qrY, qrSize, qrSize);

  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: qrSize - 2 * qrPadding, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, qrX + qrPadding, qrY + qrPadding, qrSize - 2 * qrPadding, qrSize - 2 * qrPadding);

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














