const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const fs = require('fs');
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
  openseaUrl
}) {
  const width = 1124;
  const height = 1650;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Base background
  ctx.fillStyle = '#31613D';
  ctx.fillRect(0, 0, width, height);

  // Outer white border
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, width, height);

  // Title Bar
  ctx.fillStyle = '#000';
  ctx.fillRect(40, 40, width - 80, 80);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(40, 40, width - 80, 80);
  ctx.font = 'bold 48px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText(`${collectionName.toUpperCase()} #${tokenId}`, 60, 95);

  // NFT Image Container
  const imgX = 72;
  const imgY = 140;
  const imgSize = 980;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.strokeRect(imgX, imgY, imgSize, imgSize);

  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, imgX, imgY, imgSize, imgSize);

  // Vertical "OWNER"
  ctx.save();
  ctx.translate(width - 50, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 40px Exo2';
  ctx.fillStyle = '#fff';
  ctx.fillText('OWNER', -80, 0);
  ctx.restore();

  // Traits Section Box
  const traitsBoxY = imgY + imgSize + 40;
  const traitsBoxHeight = 260;
  ctx.fillStyle = '#000';
  ctx.fillRect(40, traitsBoxY, width - 80, traitsBoxHeight);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(40, traitsBoxY, width - 80, traitsBoxHeight);

  // Traits Text
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 36px Exo2';
  ctx.fillText('TRAITS', 60, traitsBoxY + 45);

  ctx.font = '28px Exo2';
  let traitY = traitsBoxY + 90;
  const maxTraits = 7;
  const shownTraits = traits.slice(0, maxTraits);
  for (const trait of shownTraits) {
    ctx.fillText(trait, 60, traitY);
    traitY += 34;
  }
  if (traits.length > maxTraits) {
    ctx.fillText(`+ ${traits.length - maxTraits} more...`, 60, traitY);
  }

  // QR Code box
  const qrX = width - 320;
  const qrY = traitsBoxY + 20;
  const qrSize = 260;
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: qrSize, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(qrX, qrY, qrSize, qrSize);

  // Footer
  const footerY = height - 60;
  ctx.fillStyle = '#000';
  ctx.fillRect(40, footerY, width - 80, 40);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.strokeRect(40, footerY, width - 80, 40);
  ctx.font = 'bold 24px Exo2';
  ctx.fillStyle = '#fff';
  const footerText = 'Powered by PimpsDev 🚀';
  const textWidth = ctx.measureText(footerText).width;
  ctx.fillText(footerText, (width - textWidth) / 2, footerY + 28);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };







