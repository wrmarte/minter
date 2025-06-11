const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const path = require('path');

// Load font
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
  const canvasWidth = 1124;
  const canvasHeight = 1650;
  const borderPadding = 40;
  const contentWidth = canvasWidth - borderPadding * 2;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#31613D';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Outer Card Border
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.strokeRect(borderPadding, borderPadding, contentWidth, canvasHeight - borderPadding * 2);

  // Heights
  const titleHeight = 80;
  const imageHeight = 900;
  const traitQrHeight = 320;
  const footerHeight = 40;

  const titleY = borderPadding;
  const imageY = titleY + titleHeight;
  const traitQrY = imageY + imageHeight;
  const footerY = traitQrY + traitQrHeight;

  // Title
  ctx.fillStyle = '#000';
  ctx.fillRect(borderPadding, titleY, contentWidth, titleHeight);
  ctx.strokeRect(borderPadding, titleY, contentWidth, titleHeight);

  ctx.font = 'bold 42px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText(`${collectionName.toUpperCase()} #${tokenId}`, borderPadding + 20, titleY + 52);

  // NFT Image
  const nftImg = await loadImage(nftImageUrl);
  const imageX = borderPadding + 112;
  ctx.drawImage(nftImg, imageX, imageY + 20, 900, 860);
  ctx.strokeRect(imageX, imageY + 20, 900, 860);

  // OWNER Tag from top of NFT to top of QR
  const ownerStripY = imageY;
  const ownerStripHeight = traitQrY - imageY;
  ctx.save();
  ctx.translate(canvasWidth - 25, ownerStripY + ownerStripHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 34px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText('OWNER', -50, 0);
  ctx.restore();

  // Traits + QR Section
  ctx.fillStyle = '#000';
  ctx.fillRect(borderPadding, traitQrY, contentWidth, traitQrHeight);
  ctx.strokeRect(borderPadding, traitQrY, contentWidth, traitQrHeight);

  // Traits
  ctx.font = 'bold 28px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText('TRAITS', borderPadding + 20, traitQrY + 40);

  ctx.font = '24px Exo2';
  let traitY = traitQrY + 80;
  const maxTraits = 7;
  for (let i = 0; i < Math.min(traits.length, maxTraits); i++) {
    ctx.fillText(traits[i], borderPadding + 20, traitY);
    traitY += 30;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, borderPadding + 20, traitY);
  }

  // QR Code inside traits box
  const qrSize = 220;
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: qrSize });
  const qrImg = await loadImage(qrBuffer);
  const qrX = canvasWidth - borderPadding - qrSize - 20;
  const qrY = traitQrY + 50;
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
  ctx.strokeRect(qrX, qrY, qrSize, qrSize);

  // Footer
  ctx.fillStyle = '#000';
  ctx.fillRect(borderPadding, footerY, contentWidth, footerHeight);
  ctx.strokeRect(borderPadding, footerY, contentWidth, footerHeight);

  ctx.font = 'bold 22px Exo2';
  ctx.fillStyle = '#fff';
  const footerText = 'Powered by PimpsDev 🚀';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, borderPadding + (contentWidth - textWidth) / 2, footerY + 27);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };










