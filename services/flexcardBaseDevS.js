// Starting with the dev version, we'll add new metadata enhancements to `flexcardBaseDevS.js`

const { Contract } = require('ethers');
const fetch = require('node-fetch');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const path = require('path');
const QRCode = require('qrcode');
const { getProvider } = require('./provider');
const { fetchMetadataExtrasDev } = require('../utils/fetchMetadataExtrasDev');

// Register font
GlobalFonts.registerFromPath(path.join(__dirname, '../fonts/Exo2-Bold.ttf'), 'Exo2');

async function buildFlexCard(contract, tokenId, name, network = 'base') {
  const provider = getProvider(network);
  const nftContract = new Contract(contract, ['function tokenURI(uint256) view returns (string)'], provider);
  const tokenURI = await nftContract.tokenURI(tokenId);
  const metadataUrl = tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/');
  const meta = await (await fetch(metadataUrl)).json();

  const imageUrl = meta.image?.startsWith('ipfs://') ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/') : meta.image;
  const traits = (meta.attributes || []).map(t => `${t.trait_type}: ${t.value}`);

  // ✅ Pull extra metadata
  const extras = await fetchMetadataExtrasDev({ contract, tokenId, network });
  const mintedDate = extras?.minted_date;
  const rank = extras?.rank;
  const score = extras?.score;
  const floor = extras?.floor_price;
  const mintPrice = extras?.mint_price;
  const topTrait = extras?.top_trait;

  // 🖼️ Canvas render
  const canvas = createCanvas(1124, 1650);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2E3D2F';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // NFT image
  const img = await loadImage(imageUrl);
  ctx.drawImage(img, 100, 120, 800, 800);

  // Title
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 42px Exo2';
  ctx.fillText(name.toUpperCase(), 100, 60);
  ctx.fillText(`#${tokenId}`, 900, 60);

  // Traits
  ctx.font = '24px Exo2';
  traits.slice(0, 8).forEach((line, i) => {
    ctx.fillText(`• ${line}`, 100, 970 + i * 30);
  });

  // New Meta Block
  const metaLines = [
    `Rank: ${rank ?? 'N/A'}`,
    `Score: ${score ?? 'N/A'}`,
    `Top Trait: ${topTrait ?? 'N/A'}`,
    `Minted: ${mintedDate ?? 'N/A'}`,
    `Mint Price: ${mintPrice ?? 'N/A'}`,
    `Floor Price: ${floor ?? 'N/A'}`,
    `Network: ${network}`,
  ];

  metaLines.forEach((line, i) => {
    ctx.fillText(line, 100, 1250 + i * 28);
  });

  // QR
  const qrBuf = await QRCode.toBuffer(`https://opensea.io/assets/${network}/${contract}/${tokenId}`);
  const qrImg = await loadImage(qrBuf);
  ctx.drawImage(qrImg, 920, 1300, 180, 180);

  return canvas.toBuffer('image/png');
}

module.exports = { buildFlexCard };
