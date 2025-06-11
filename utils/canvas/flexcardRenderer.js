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

  // Green background + outer border
  ctx.fillStyle = '#31613D';
  ctx.fillRect(0, 0, width, height);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(0, 0, width, height);

  // Title Bar
  ctx.fillStyle = '#000';
  ctx.fillRect(40, 40, width - 80, 80);
  ctx.strokeRect(40, 40, width - 80, 80);
  ctx.font = 'bold 42px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText(`${collectionName.toUpperCase()} #${tokenId}`, 60, 95);

  // NFT Image box (centered)
  const imgX = 112;
  const imgY = 140;
  const imgSize = 900;
  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, imgX, imgY, imgSize, imgSize);
  ctx.strokeRect(imgX, imgY, imgSize, imgSize);

  // OWNER vertical tag
  ctx.save();
  ctx.translate(width - 35, imgY + imgSize / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 34px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText('OWNER', -50, 0);
  ctx.restore();

  // Traits + QR Container
  const traitsY = imgY + imgSize + 30;
  const boxHeight = 320;
  ctx.fillStyle = '#000';
  ctx.fillRect(40, traitsY, width - 80, boxHeight);
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(40, traitsY, width - 80, boxHeight);

  // "TRAITS" header
  ctx.font = 'bold 30px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText('TRAITS', 60, traitsY + 40);

  // Traits list
  ctx.font = '24px Exo2';
  let traitY = traitsY + 80;
  const maxTraits = 7;
  for (let i = 0; i < Math.min(traits.length, maxTraits); i++) {
    ctx.fillText(traits[i], 60, traitY);
    traitY += 30;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, 60, traitY);
  }

  // QR Code
  const qrSize = 220;
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: qrSize });
  const qrImg = await loadImage(qrBuffer);
  const qrX = width - qrSize - 80;
  const qrY = traitsY + 50;
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
  ctx.strokeRect(qrX, qrY, qrSize, qrSize);

  // Footer
  const footerY = height - 60;
  ctx.fillStyle = '#000';
  ctx.fillRect(40, footerY, width - 80, 40);
  ctx.strokeRect(40, footerY, width - 80, 40);
  ctx.font = 'bold 22px Exo2';
  ctx.fillStyle = '#fff';
  const footerText = 'Powered by PimpsDev 🚀';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, (width - textWidth) / 2, footerY + 27);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };









