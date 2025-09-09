// ✅ utils/canvas/floppyRenderer.js — stable random floppy color logic with meta/rank fallback
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const path = require('path');
const { fetchMetadata } = require('../../utils/fetchMetadata');
const { fetchMetadataExtras } = require('../../utils/fetchMetadataExtras');
const { getTokenRank } = require('../../utils/rank/getTokenRank'); // ⬅️ robust rank fetcher (Reservoir + optional OS)

const fontPath = path.join(__dirname, '../../fonts/Exo2-Bold.ttf');
GlobalFonts.registerFromPath(fontPath, 'Exo2');

const FLOPPY_COLORS = ['red', 'yellow', 'green', 'blue', 'purple', 'black'];

/** Stable color selection (same token ⇒ same color) */
function stablePickColor(contractAddress, tokenId) {
  const s = (String(contractAddress || '') + ':' + String(tokenId || '')).toLowerCase();
  // simple fast hash (djb2-ish)
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
  const idx = Math.abs(h) % FLOPPY_COLORS.length;
  return FLOPPY_COLORS[idx];
}

function getRandomFloppyPath() {
  const color = FLOPPY_COLORS[Math.floor(Math.random() * FLOPPY_COLORS.length)];
  return path.resolve(__dirname, `../../assets/floppies/floppy-${color}.png`);
}

function getStableFloppyPath(contractAddress, tokenId) {
  const color = stablePickColor(contractAddress, tokenId);
  return path.resolve(__dirname, `../../assets/floppies/floppy-${color}.png`);
}

/** Try to read rank from metadata objects in the wild */
function extractRankFromMeta(meta, metaExtras) {
  const m = meta || {};
  const x = metaExtras || {};
  // Cover common provider fields
  const candidates = [
    m.rank, m.rarity_rank, m.rarityRank, m.rarity?.rank,
    x.rank, x.rarity_rank, x.rarityRank, x.rarity?.rank
  ].filter(v => v !== undefined && v !== null);

  if (!candidates.length) return null;
  const first = Number(candidates[0]);
  return Number.isFinite(first) ? first : null;
}

/** Normalize traits array from various shapes */
function extractTraits(meta, metaExtras) {
  if (Array.isArray(meta?.traits) && meta.traits.length) return meta.traits;
  if (Array.isArray(meta?.attributes) && meta.attributes.length) return meta.attributes;
  if (Array.isArray(metaExtras?.traits) && metaExtras.traits.length) return metaExtras.traits;
  return [];
}

/** Resolve a best-guess permalink for the QR */
function resolvePermalink(meta, contractAddress, tokenId, chain) {
  if (meta?.permalink) return meta.permalink;
  // Basescan style (works for ERC721 and many 1155 UIs)
  if (chain === 'base') return `https://basescan.org/token/${contractAddress}?a=${tokenId}`;
  // fallback
  return `https://basescan.org/token/${contractAddress}?a=${tokenId}`;
}

/**
 * Build the floppy card.
 * @param {string} contractAddress
 * @param {string|number|bigint} tokenId - recommend decimal string (no precision loss)
 * @param {string} collectionName
 * @param {string} chain - e.g., 'base'
 * @param {string|null} floppyPath - explicit path to a floppy image, else we pick stable color
 * @param {object} [options]
 * @param {{rank:number|null,totalSupply:number|null,source:string}|null} [options.rarity]
 */
async function buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath = null, options = {}) {
  const canvas = createCanvas(600, 600);
  const ctx = canvas.getContext('2d');

  const tokenIdStr = String(tokenId);

  try {
    // 1) Metadata & extras
    const meta = await fetchMetadata(contractAddress, tokenIdStr, chain);
    const metaExtras = await fetchMetadataExtras(contractAddress, tokenIdStr, chain);

    // 2) Image
    const placeholderPath = path.resolve(__dirname, '../../assets/placeholders/nft-placeholder.png');
    const nftSrc = meta.image_fixed || meta.image || placeholderPath;
    const nftImage = await loadImage(nftSrc);

    // 3) Floppy base (explicit color, else stable)
    const finalFloppyPath = floppyPath || getStableFloppyPath(contractAddress, tokenIdStr);
    const floppyImage = await loadImage(finalFloppyPath);

    // 4) QR
    const qrCanvas = createCanvas(90, 90);
    await QRCode.toCanvas(qrCanvas, resolvePermalink(meta, contractAddress, tokenIdStr, chain), {
      margin: 1,
      color: { dark: '#000000', light: '#00000000' },
    });
    const qrImage = await loadImage(qrCanvas.toBuffer('image/png'));

    // 5) Compose
    ctx.drawImage(floppyImage, 0, 0, 600, 600);
    ctx.drawImage(nftImage, 155, 50, 275, 275);
    ctx.drawImage(qrImage, 65, 480, 60, 60);

    // 6) Text: collection, traits, rank
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 20px Exo2';
    ctx.textAlign = 'left';

    const traitsArray = extractTraits(meta, metaExtras);
    const traitsCount = traitsArray.length;

    // Rank resolution order:
    //   a) options.rarity.rank (from command if already fetched)
    //   b) meta/metaExtras fields
    //   c) live fetch via getTokenRank (Reservoir + optional OpenSea)
    let rankValue =
      (options?.rarity && options.rarity.rank != null ? Number(options.rarity.rank) : null) ??
      extractRankFromMeta(meta, metaExtras);

    if (rankValue == null) {
      try {
        const rankInfo = await getTokenRank({ chain, contract: String(contractAddress).toLowerCase(), tokenId: tokenIdStr });
        if (rankInfo && rankInfo.rank != null) rankValue = Number(rankInfo.rank);
      } catch (e) {
        // non-fatal: keep N/A
      }
    }

    const rankText = rankValue != null && Number.isFinite(rankValue) ? String(rankValue) : 'N/A';
    ctx.fillText(`${collectionName} #${tokenIdStr} • Traits: ${traitsCount} • Rank: ${rankText}`, 100, 350);

    // Side label
    ctx.save();
    ctx.translate(500, 315);
    ctx.rotate(-Math.PI / 2);
    ctx.font = 'bold 18px Exo2';
    ctx.fillText(`Minted with $ADRIAN on Base`, 0, 0);
    ctx.restore();

  } catch (err) {
    console.warn('❌ buildFloppyCard error:', err);
    ctx.fillStyle = '#111';
    ctx.fillRect(20, 20, 600, 600);
    ctx.font = 'bold 30px Arial';
    ctx.fillStyle = '#fff';
    ctx.fillText('Error Loading NFT', 150, 300);
  }

  return canvas.toBuffer('image/png');
}

module.exports = {
  buildFloppyCard,
  getRandomFloppyPath,
  getStableFloppyPath
};





