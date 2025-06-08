const { createCanvas, loadImage } = require('@napi-rs/canvas');
const QRCode = require('qrcode');

async function generateFlexCard({
  nftImageUrl,
  collectionName,
  tokenId,
  traits,
  owner,
  openseaUrl
}) {
  const width = 1124;
  const height = 1600;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#7AA547'; // Greenish background
  ctx.fillRect(0, 0, width, height);

  // Load NFT image
  const nftImg = await loadImage(nftImageUrl);
  ctx.drawImage(nftImg, 100, 100, 900, 900);

  // Title box
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 1020, width, 80);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 40px Arial';
  ctx.fillText(`${(collectionName || "NFT").toUpperCase()} #${tokenId}`, 50, 1075);

  // Traits box
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 1120, width, 350);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 34px Arial';
  ctx.fillText('TRAITS', 50, 1160);

  ctx.font = '30px Arial';
  let traitY = 1200;
  for (const trait of traits) {
    ctx.fillText(`${trait}`, 50, traitY);
    traitY += 40;
  }

  // Owner box
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 1480, width, 60);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 32px Arial';
  ctx.fillText(`OWNER: ${owner || 'Unknown'}`, 50, 1520);

  // QR Code
  const qrBuffer = await QRCode.toBuffer(openseaUrl, { width: 300, margin: 1 });
  const qrImg = await loadImage(qrBuffer);
  ctx.drawImage(qrImg, width - 350, 1150, 250, 250);

  return canvas.toBuffer('image/png');
}

module.exports = { generateFlexCard };

