// services/gift/revealRenderer.js
// ======================================================
// Gift Reveal Renderer (WOW Step 6)
// - Renders a cinematic reveal card (PNG) using @napi-rs/canvas
// - Supports BOTH:
//    ✅ NFT reveal (uses payload.image OR metadataUrl -> image field)
//    ✅ Token reveal (amount/symbol/label + optional logoUrl)
// - Safe IPFS handling + safe fetch with timeout
// ======================================================

const path = require("path");

let Canvas = null;
try {
  Canvas = require("@napi-rs/canvas");
} catch (e) {
  // fallback (if some env uses node-canvas)
  try {
    Canvas = require("canvas");
  } catch {
    Canvas = null;
  }
}

const DEBUG = String(process.env.GIFT_REVEAL_DEBUG || "").trim() === "1";

// Default IPFS gateway for resolving ipfs:// links
const IPFS_GATEWAY =
  (process.env.GIFT_IPFS_GATEWAY || process.env.IPFS_GATEWAY || "").trim() ||
  "https://ipfs.io/ipfs/";

function log(...a) {
  if (DEBUG) console.log("[GIFT_REVEAL]", ...a);
}

function safeStr(v, max = 220) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function toHttpUrl(u) {
  const s = String(u || "").trim();
  if (!s) return null;

  // ipfs://CID/... -> gateway/CID/...
  if (s.startsWith("ipfs://")) {
    const rest = s.replace("ipfs://", "");
    return IPFS_GATEWAY.replace(/\/+$/, "/") + rest.replace(/^\/+/, "");
  }

  // ipfs/CID in plain form
  if (s.startsWith("ipfs/")) {
    const rest = s.replace(/^ipfs\//, "");
    return IPFS_GATEWAY.replace(/\/+$/, "/") + rest.replace(/^\/+/, "");
  }

  return s;
}

async function safeFetch(url, opts = {}) {
  const u = toHttpUrl(url);
  if (!u) return null;

  const timeoutMs = Number(opts.timeoutMs || 12000);
  const headers = opts.headers || {};

  // Node 18+ has global fetch; fallback to node-fetch if needed
  let fetchFn = globalThis.fetch;
  if (!fetchFn) {
    try {
      fetchFn = require("node-fetch");
    } catch {
      fetchFn = null;
    }
  }
  if (!fetchFn) return null;

  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

  try {
    const res = await fetchFn(u, {
      method: "GET",
      headers,
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res || !res.ok) return null;
    return res;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchJson(url, opts = {}) {
  const res = await safeFetch(url, opts);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchBuffer(url, opts = {}) {
  const res = await safeFetch(url, opts);
  if (!res) return null;
  try {
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

function tryRegisterFonts() {
  if (!Canvas?.GlobalFonts?.registerFromPath) return;

  // Try multiple possible paths (Railway is case-sensitive)
  const candidates = [
    // common in your project
    path.join(process.cwd(), "assets", "fonts", "DejaVuSans.ttf"),
    path.join(process.cwd(), "assets", "fonts", "DejaVuSans-Bold.ttf"),
    path.join(process.cwd(), "assets", "fonts", "DejaVuSansCondensed.ttf"),
    // alt location some repos use
    path.join(process.cwd(), "app", "assets", "fonts", "DejaVuSans.ttf"),
    path.join(process.cwd(), "app", "assets", "fonts", "DejaVuSans-Bold.ttf"),
  ];

  for (const p of candidates) {
    try {
      Canvas.GlobalFonts.registerFromPath(p, "DejaVuSans");
      log("registered font:", p);
      break;
    } catch {}
  }
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawGlowFrame(ctx, x, y, w, h) {
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.shadowBlur = 30;
  ctx.shadowColor = "rgba(0, 200, 255, 0.55)";
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(0, 200, 255, 0.35)";
  roundedRect(ctx, x, y, w, h, 26);
  ctx.stroke();

  ctx.shadowColor = "rgba(255, 0, 120, 0.45)";
  ctx.strokeStyle = "rgba(255, 0, 120, 0.28)";
  ctx.lineWidth = 8;
  roundedRect(ctx, x + 3, y + 3, w - 6, h - 6, 24);
  ctx.stroke();
  ctx.restore();
}

function drawBackground(ctx, W, H) {
  // gradient
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#080A12");
  g.addColorStop(0.45, "#0B1024");
  g.addColorStop(1, "#12081A");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, Math.max(W, H) / 1.2);
  v.addColorStop(0, "rgba(255,255,255,0.03)");
  v.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);

  // tiny stars
  ctx.save();
  ctx.globalAlpha = 0.35;
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = Math.random() * 1.8;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function fitRect(imgW, imgH, boxW, boxH) {
  const s = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * s;
  const h = imgH * s;
  const x = (boxW - w) / 2;
  const y = (boxH - h) / 2;
  return { x, y, w, h };
}

async function tryLoadImage(bufOrUrl) {
  if (!Canvas?.loadImage) return null;

  try {
    if (Buffer.isBuffer(bufOrUrl)) {
      return await Canvas.loadImage(bufOrUrl);
    }
    // string URL -> buffer first for better compatibility
    const b = await fetchBuffer(bufOrUrl, { timeoutMs: 12000 });
    if (!b) return null;
    return await Canvas.loadImage(b);
  } catch {
    return null;
  }
}

/**
 * Resolve NFT image:
 * - payload.image / payload.image_url / payload.imageUrl
 * - payload.metadataUrl -> JSON -> image fields
 */
async function resolveNftImageUrl(payload) {
  if (!payload || typeof payload !== "object") return null;

  const direct =
    payload.image ||
    payload.image_url ||
    payload.imageUrl ||
    payload.imageURI ||
    payload.imageUri;

  if (direct) return toHttpUrl(direct);

  const metaUrl = payload.metadataUrl || payload.metadata_url || payload.tokenUri || payload.tokenURI || payload.uri;
  if (!metaUrl) return null;

  const meta = await fetchJson(metaUrl, { timeoutMs: 12000 });
  if (!meta || typeof meta !== "object") return null;

  const img =
    meta.image ||
    meta.image_url ||
    meta.imageUrl ||
    meta.imageURI ||
    meta.imageUri ||
    (meta.metadata && (meta.metadata.image || meta.metadata.image_url));

  return img ? toHttpUrl(img) : null;
}

/**
 * Resolve token logo:
 * - payload.logoUrl / logo_url / icon
 */
function resolveTokenLogoUrl(payload) {
  if (!payload || typeof payload !== "object") return null;
  const u = payload.logoUrl || payload.logo_url || payload.icon || payload.iconUrl;
  return u ? toHttpUrl(u) : null;
}

/**
 * Main render function
 * @param {object} args
 * @returns { buffer, filename, contentType }
 */
async function renderGiftRevealCard(args = {}) {
  if (!Canvas?.createCanvas) {
    return { buffer: null, filename: null, contentType: null };
  }

  tryRegisterFonts();

  const W = Number(process.env.GIFT_REVEAL_W || 1200);
  const H = Number(process.env.GIFT_REVEAL_H || 675);

  const prizeType = String(args.prizeType || "text").toLowerCase();
  const prizeLabel = safeStr(args.prizeLabel || "Mystery prize 🎁", 220);
  const winnerTag = safeStr(args.winnerTag || "", 120);
  const winnerId = String(args.winnerId || "");

  const payload = args.prizePayload && typeof args.prizePayload === "object" ? args.prizePayload : null;

  const canvas = Canvas.createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx, W, H);

  // Header
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.font = "800 56px DejaVuSans, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillText("🎁 GIFT OPENED", 48, 86);

  ctx.font = "500 26px DejaVuSans, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  const whoLine = winnerId ? `Winner: @${winnerTag || winnerId}` : "Winner:";
  ctx.fillText(whoLine, 52, 128);
  ctx.restore();

  // Center frame box
  const boxX = 64;
  const boxY = 160;
  const boxW = W - 128;
  const boxH = H - 250;

  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  roundedRect(ctx, boxX, boxY, boxW, boxH, 28);
  ctx.fill();
  ctx.restore();

  drawGlowFrame(ctx, boxX, boxY, boxW, boxH);

  // Prepare art area (left) + text area (right)
  const artPad = 30;
  const artX = boxX + artPad;
  const artY = boxY + artPad;
  const artW = Math.floor(boxW * 0.46);
  const artH = boxH - artPad * 2;

  const textX = artX + artW + 26;
  const textY = artY + 10;
  const textW = boxX + boxW - textX - artPad;

  // Determine image
  let imageUrl = null;
  if (prizeType === "nft") {
    imageUrl = await resolveNftImageUrl(payload);
  } else if (prizeType === "token") {
    imageUrl = resolveTokenLogoUrl(payload);
  } else {
    // optionally allow payload.image even for text
    if (payload?.image) imageUrl = toHttpUrl(payload.image);
  }

  // Draw image if possible
  let imgDrawn = false;
  if (imageUrl) {
    const img = await tryLoadImage(imageUrl);
    if (img) {
      ctx.save();
      ctx.globalAlpha = 0.95;

      // rounded clip
      roundedRect(ctx, artX, artY, artW, artH, 24);
      ctx.clip();

      const fit = fitRect(img.width || artW, img.height || artH, artW, artH);
      ctx.drawImage(img, artX + fit.x, artY + fit.y, fit.w, fit.h);

      ctx.restore();

      // overlay shine
      ctx.save();
      const shine = ctx.createLinearGradient(artX, artY, artX + artW, artY + artH);
      shine.addColorStop(0, "rgba(255,255,255,0.08)");
      shine.addColorStop(0.4, "rgba(255,255,255,0.01)");
      shine.addColorStop(1, "rgba(255,255,255,0.08)");
      ctx.fillStyle = shine;
      roundedRect(ctx, artX, artY, artW, artH, 24);
      ctx.fill();
      ctx.restore();

      imgDrawn = true;
    }
  }

  // If no image, draw a stylized placeholder icon
  if (!imgDrawn) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    roundedRect(ctx, artX, artY, artW, artH, 24);
    ctx.fill();

    ctx.font = "900 92px DejaVuSans, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    const icon = prizeType === "token" ? "🪙" : (prizeType === "nft" ? "🖼️" : "🎁");
    ctx.fillText(icon, artX + 18, artY + 110);

    ctx.font = "600 26px DejaVuSans, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillText(prizeType.toUpperCase(), artX + 18, artY + 150);

    ctx.restore();
  }

  // Text block
  ctx.save();
  ctx.globalAlpha = 0.95;

  ctx.font = "800 34px DejaVuSans, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  const head =
    prizeType === "nft" ? "NFT REVEAL" :
    prizeType === "token" ? "TOKEN REWARD" :
    "PRIZE REVEAL";
  ctx.fillText(head, textX, textY + 40);

  ctx.font = "500 24px DejaVuSans, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  ctx.fillText("Prize:", textX, textY + 86);

  // Wrap prize label
  ctx.font = "700 30px DejaVuSans, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.98)";
  const words = prizeLabel.split(" ");
  let line = "";
  let y = textY + 128;
  const maxW = textW;

  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    const m = ctx.measureText(test);
    if (m.width > maxW && line) {
      ctx.fillText(line, textX, y);
      line = w;
      y += 40;
      if (y > textY + artH - 20) break;
    } else {
      line = test;
    }
  }
  if (line && y <= textY + artH - 20) ctx.fillText(line, textX, y);

  // Optional details for token payload
  if (prizeType === "token" && payload && typeof payload === "object") {
    const amount = payload.amount != null ? safeStr(payload.amount, 60) : "";
    const symbol = payload.symbol != null ? safeStr(payload.symbol, 24) : "";
    const chain = payload.chain != null ? safeStr(payload.chain, 24) : "";
    const extraLine = [amount && symbol ? `${amount} ${symbol}` : "", chain ? `chain: ${chain}` : ""].filter(Boolean).join(" • ");

    if (extraLine) {
      ctx.font = "500 20px DejaVuSans, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.fillText(extraLine, textX, Math.min(textY + artH - 18, y + 60));
    }
  }

  ctx.restore();

  // Footer
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.font = "500 18px DejaVuSans, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  const footer = safeStr(args.footer || "Minter Plus • Gift Drop", 140);
  ctx.fillText(footer, 52, H - 34);
  ctx.restore();

  const buffer = canvas.toBuffer("image/png");
  return {
    buffer,
    filename: "gift-reveal.png",
    contentType: "image/png",
    resolvedImageUrl: imageUrl || null,
  };
}

module.exports = {
  renderGiftRevealCard,
  toHttpUrl,
};
