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
  const marginX = 40;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background and outer stroke
  ctx.fillStyle = '#31613D';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, width, height);

  // === Title Box ===
  const sectionX = marginX;
  const sectionWidth = width - marginX * 2;
  const titleHeight = 80;
  const titleY = marginX;

  ctx.fillStyle = '#000';
  ctx.fillRect(sectionX, titleY, sectionWidth, titleHeight);
  ctx.strokeRect(sectionX, titleY, sectionWidth, titleHeight);
  ctx.font = 'bold 42px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText(`${collectionName.toUpperCase()} #${tokenId}`, sectionX + 20, titleY + 52);

  // === Image Box ===
  const imgSize = 900;
  const imgY = titleY + titleHeight + 20;
  const imgX = sectionX + (sectionWidth - imgSize) / 2;
  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, imgX, imgY, imgSize, imgSize);
  ctx.strokeRect(imgX, imgY, imgSize, imgSize);

  // === OWNER Vertical ===
  ctx.save();
  ctx.translate(width - 30, imgY + imgSize / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 34px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText('OWNER', -50, 0);
  ctx.restore();

  // === Traits + QR Code Section ===
  const traitsY = imgY + imgSize + 30;
  const traitsHeight = 300;
  ctx.fillStyle = '#000';
  ctx.fillRect(sectionX, traitsY, sectionWidth, traitsHeight);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(sectionX, traitsY, sectionWidth, traitsHeight);

  // Traits Title
  ctx.font = 'bold 30px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText('TRAITS', sectionX + 20, traitsY + 40);

  // Traits List
  ctx.font = '24px Exo2';
  let ty = traitsY + 80;
  const maxTraits = 7;
  for (let i = 0; i < Math.min(traits.length, maxTraits); i++) {
    ctx.fillText(traits[i], sectionX + 20, ty);
    ty += 30;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, sectionX + 20, ty);
  }

  // QR Code Placement
  const qrSize = 220;
  const qrX = sectionX + sectionWidth - qrSize - 20;
  const qrY = traitsY + 40;
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: qrSize });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
  ctx.strokeRect(qrX, qrY, qrSize, qrSize);

  // === Footer ===
  const footerHeight = 40;
  const footerY = height - footerHeight - marginX;
  ctx.fillStyle = '#000';
  ctx.fillRect(sectionX, footerY, sectionWidth, footerHeight);
  ctx.strokeRect(sectionX, footerY, sectionWidth, footerHeight);

  ctx.font = 'bold 22px Exo2';
  ctx.fillStyle = '#fff';
  const footerText = 'Powered by PimpsDev 🚀';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, sectionX + (sectionWidth - textWidth) / 2, footerY + 27);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };









