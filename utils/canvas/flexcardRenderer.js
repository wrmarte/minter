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
  const width = 1124;
  const height = 1650;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background color
  ctx.fillStyle = '#31613D';
  ctx.fillRect(0, 0, width, height);

  // Outer white border
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, width, height);

  // Header Title Bar
  ctx.fillStyle = '#000';
  ctx.fillRect(40, 40, width - 80, 60);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(40, 40, width - 80, 60);
  ctx.font = 'bold 38px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText(`${collectionName.toUpperCase()} #${tokenId}`, 60, 82);

  // NFT Image box
  const imgX = 112;
  const imgY = 130;
  const imgSize = 900;
  ctx.drawImage(await loadImage(nftImageUrl), imgX, imgY, imgSize, imgSize);
  ctx.strokeRect(imgX, imgY, imgSize, imgSize);

  // Vertical OWNER tag
  ctx.save();
  ctx.translate(width - 35, imgY + imgSize / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 34px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText('OWNER', -50, 0);
  ctx.restore();

  // Traits Box
  const traitsY = imgY + imgSize + 30;
  const traitsBoxHeight = 300;
  ctx.fillStyle = '#000';
  ctx.fillRect(40, traitsY, width - 80, traitsBoxHeight);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(40, traitsY, width - 80, traitsBoxHeight);

  ctx.font = 'bold 28px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText('TRAITS', 60, traitsY + 40);

  ctx.font = '24px Exo2';
  let y = traitsY + 80;
  for (let i = 0; i < Math.min(traits.length, 7); i++) {
    ctx.fillText(traits[i], 60, y);
    y += 30;
  }
  if (traits.length > 7) {
    ctx.fillText(`+ ${traits.length - 7} more...`, 60, y);
  }

  // QR Code
  const qrSize = 240;
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: qrSize });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, width - qrSize - 60, traitsY + 40, qrSize, qrSize);
  ctx.strokeRect(width - qrSize - 60, traitsY + 40, qrSize, qrSize);

  // Footer
  const footerY = height - 60;
  ctx.fillStyle = '#000';
  ctx.fillRect(40, footerY, width - 80, 40);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(40, footerY, width - 80, 40);

  ctx.font = 'bold 22px Exo2';
  ctx.fillStyle = '#fff';
  const footerText = 'Powered by PimpsDev 🚀';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, (width - textWidth) / 2, footerY + 28);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };








