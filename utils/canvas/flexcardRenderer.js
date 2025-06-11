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
  openseaUrl
}) {
  const width = 1124;
  const height = 1650;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Colors & Dimensions
  const bgColor = '#31613D';
  const borderColor = '#ffffff';
  const titleBarHeight = 120;
  const footerHeight = 40;
  const ownerWidth = 140;
  const margin = 40;
  const contentWidth = width - 2 * margin - ownerWidth;
  const qrSize = 300;
  const qrPadding = 20;

  // Background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);

  // Outer border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  ctx.strokeRect(margin, margin, width - 2 * margin, height - 2 * margin);

  // Title bar
  ctx.fillStyle = '#000';
  ctx.fillRect(margin, margin, width - 2 * margin, titleBarHeight);
  ctx.strokeRect(margin, margin, width - 2 * margin, titleBarHeight);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 42px Exo2';
  ctx.fillText(`${(collectionName || 'NFT').toUpperCase()} #${tokenId}`, width / 2, margin + titleBarHeight / 2 + 15);

  // NFT image
  const nftWidth = contentWidth - 160;
  const nftHeight = 800;
  const nftX = margin + (contentWidth - nftWidth) / 2;
  const nftY = 190 + (880 - nftHeight) / 2;

  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, nftX, nftY, nftWidth, nftHeight);
  ctx.strokeRect(nftX, nftY, nftWidth, nftHeight);

  // Owner strip (right)
  const ownerX = width - margin - ownerWidth;
  const ownerY = 160;
  const ownerH = 1220;
  ctx.strokeRect(ownerX, ownerY, ownerWidth, ownerH);
  ctx.save();
  ctx.translate(ownerX + ownerWidth / 2, ownerY + ownerH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 32px Exo2';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 0, 0);
  ctx.restore();

  // Traits title bar
  const traitsTitleY = nftY + 800 + 40;
  const traitsTitleHeight = 60;
  ctx.fillStyle = '#000';
  ctx.fillRect(margin, traitsTitleY, contentWidth, traitsTitleHeight);
  ctx.strokeRect(margin, traitsTitleY, contentWidth, traitsTitleHeight);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 26px Exo2';
  ctx.fillText('TRAITS', margin + 20, traitsTitleY + 40);

  // Traits info
  const traitsY = traitsTitleY + traitsTitleHeight;
  const traitsHeight = 240;
  ctx.fillStyle = bgColor;
  ctx.fillRect(margin, traitsY, contentWidth, traitsHeight);
  ctx.strokeRect(margin, traitsY, contentWidth, traitsHeight);
  ctx.fillStyle = '#fff';
  ctx.font = '22px Exo2';
  const maxTraits = 8;
  let traitY = traitsY + 36;
  for (let i = 0; i < Math.min(traits.length, maxTraits); i++) {
    ctx.fillText(`• ${traits[i]}`, margin + 20, traitY);
    traitY += 30;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, margin + 20, traitY);
  }

  // QR Zone
  const qrX = width - margin - qrSize;
  const qrY = height - footerHeight - qrSize;
  ctx.fillStyle = '#fff';
  ctx.fillRect(qrX, qrY, qrSize, qrSize);

  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: qrSize - qrPadding * 2, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, qrX + qrPadding, qrY + qrPadding, qrSize - qrPadding * 2, qrSize - qrPadding * 2);

  // Footer
  ctx.fillStyle = '#000';
  ctx.fillRect(margin, height - footerHeight, width - 2 * margin, footerHeight);
  ctx.strokeRect(margin, height - footerHeight, width - 2 * margin, footerHeight);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 24px Exo2';
  ctx.textAlign = 'center';
  ctx.fillText('Powered by PimpsDev 🚀', width / 2, height - footerHeight / 2 + 8);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };











