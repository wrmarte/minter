// ✅ utils/canvas/floppyRenderer.js — Stable build with random floppy color only, keeping logic untouched
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const path = require('path');
const { fetchMetadata } = require('../../utils/fetchMetadata');
const { fetchMetadataExtras } = require('../../utils/fetchMetadataExtras');

const fontPath = path.join(__dirname, '../../fonts/Exo2-Bold.ttf');
GlobalFonts.registerFromPath(fontPath, 'Exo2');

const FLOPPY_COLORS = ['red', 'yellow', 'green', 'blue', 'purple', 'black'];

function getRandomFloppyPath() {
  const color = FLOPPY_COLORS[Math.floor(Math.random() * FLOPPY_COLORS.length)];
  return path.resolve(__dirname, `../../assets/floppies/floppy-${color}.png`);
}

async function buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath) {
  const canvas = createCanvas(600, 600);
  const ctx = canvas.getContext('2d');

  try {
    const meta = await fetchMetadata(contractAddress, tokenId, chain);
    const metaExtras = await fetchMetadataExtras(contractAddress, tokenId, chain);

    const localPlaceholder = path.resolve(__dirname, '../../assets/placeholders/nft-placeholder.png');
    const nftImage = await loadImage(meta.image_fixed || meta.image || localPlaceholder);

    const finalFloppyPath = floppyPath || getRandomFloppyPath();
    const floppyImage = await loadImage(finalFloppyPath);

    const qrCanvas = createCanvas(90, 90);
    await QRCode.toCanvas(qrCanvas, meta.permalink || `https://basescan.org/token/${contractAddress}?a=${tokenId}`, {
      margin: 1,
      color: {
        dark: '#000000',
        light: '#00000000'
      }
    });
    const qrImage = await loadImage(qrCanvas.toBuffer('image/png'));

    ctx.drawImage(floppyImage, 0, 0, 600, 600);
    ctx.drawImage(nftImage, 155, 50, 275, 275);
    ctx.drawImage(qrImage, 65, 480, 60, 60);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = '#000000';

    ctx.font = 'bold 20px Exo2';
    ctx.textAlign = 'left';

    const traitsArray = meta.traits?.length ? meta.traits : meta.attributes || metaExtras.traits || [];
    const traitsCount = traitsArray.length;
    const rankValue = meta.rank || meta.rarity_rank || metaExtras.rank || metaExtras.rarity_rank || 'N/A';

    ctx.fillText(`${collectionName} #${tokenId} • Traits: ${traitsCount} • Rank: ${rankValue}`, 100, 350);

    ctx.save();
    ctx.translate(500, 315);
    ctx.rotate(-Math.PI / 2);
    ctx.font = 'bold 18px Exo2';
    ctx.fillText(`Minted with $ADRIAN on Base`, 0, 0);
    ctx.restore();
  } catch (err) {
    console.warn('❌ buildFloppyCard error:', err);
    ctx.fillStyle = '#111';




















