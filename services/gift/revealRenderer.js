// services/gift/revealRenderer.js
// ======================================================
// Gift Reveal Renderer (WOW Step 6)
// - Renders a cinematic reveal card (PNG) using @napi-rs/canvas
// - Supports BOTH:
//    ✅ NFT reveal (image, metadataUrl, OR contract+tokenId auto-resolve)
//    ✅ Token reveal (amount/symbol/label + optional logoUrl)
// - IPFS + data: URIs + safe fetch timeout
// - Auto image resolution order for NFT:
//    1) payload.image / imageUrl / image_uri
//    2) payload.metadataUrl / tokenUri -> fetch JSON -> image
//    3) payload.contract + payload.tokenId (or ca+id):
//          a) Reservoir (if RESERVOIR_API_KEY set)
//          b) On-chain tokenURI() via providerM.safeRpcCall (base/eth)
// ======================================================

const path = require("path");
const crypto = require("crypto");

let Canvas = null;
try {
  Canvas = require("@napi-rs/canvas");
} catch (e) {
  try {
    Canvas = require("canvas");
  } catch {
    Canvas = null;
  }
}

// providerM (for on-chain tokenURI fallback)
let safeRpcCall = null;
try {
  const mod = require("../providerM");
  if (mod && typeof mod.safeRpcCall === "function") safeRpcCall = mod.safeRpcCall;
} catch {}

let ethers = null;
try {
  ethers = require("ethers");
} catch {}

const DEBUG = String(process.env.GIFT_REVEAL_DEBUG || "").trim() === "1";

// Default IPFS gateway for resolving ipfs:// links
const IPFS_GATEWAY =
  (process.env.GIFT_IPFS_GATEWAY || process.env.IPFS_GATEWAY || "").trim() ||
  "https://ipfs.io/ipfs/";

// Reservoir
const RESERVOIR_API_KEY = String(process.env.RESERVOIR_API_KEY || "").trim();
const RESERVOIR_BASE_URL = (process.env.RESERVOIR_BASE_URL || "https://api.reservoir.tools").trim();

function log(...a) {
  if (DEBUG) console.log("[GIFT_REVEAL]", ...a);
}

function safeStr(v, max = 220) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function isDataUrl(s) {
  const t = String(s || "").trim();
  return /^data:/i.test(t);
}

function parseDataUrl(dataUrl) {
  // returns { mime, buffer } or null
  const s = String(dataUrl || "").trim();
  if (!/^data:/i.test(s)) return null;

  // data:[<mime>][;base64],<data>
  const idx = s.indexOf(",");
  if (idx === -1) return null;

  const meta = s.slice(5, idx);
  const data = s.slice(idx + 1);

  const isB64 = /;base64/i.test(meta);
  const mime = (meta.split(";")[0] || "application/octet-stream").trim() || "application/octet-stream";

  try {
    const buf = isB64 ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data), "utf8");
    return { mime, buffer: buf };
  } catch {
    return null;
  }
}

function toHttpUrl(u) {
  const s = String(u || "").trim();
  if (!s) return null;

  // allow data URLs through (handled elsewhere)
  if (/^data:/i.test(s)) return s;

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

  // data urls are not fetchable
  if (isDataUrl(u)) return null;

  const timeoutMs = Number(opts.timeoutMs || 12000);
  const headers = Object.assign(
    {
      "user-agent": "MinterPlus-GiftReveal/1.0",
      "accept": "*/*",
    },
    opts.headers || {}
  );

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
      redirect: "follow",
    });
    if (!res || !res.ok) {
      log("fetch failed:", u, "status=", res?.status);
      return null;
    }
    return res;
  } catch (e) {
    log("fetch exception:", u, e?.message || e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchJson(url, opts = {}) {
  const u = toHttpUrl(url);
  if (!u) return null;

  // handle data:application/json;base64,...
  if (isDataUrl(u)) {
    const parsed = parseDataUrl(u);
    if (!parsed) return null;
    try {
      const txt = parsed.buffer.toString("utf8");
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }

  const res = await safeFetch(u, opts);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchBuffer(url, opts = {}) {
  const u = toHttpUrl(url);
  if (!u) return null;

  if (isDataUrl(u)) {
    const parsed = parseDataUrl(u);
    return parsed?.buffer || null;
  }

  const res = await safeFetch(u, opts);
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

  const candidates = [
    path.join(process.cwd(), "assets", "fonts", "DejaVuSans.ttf"),
    path.join(process.cwd(), "assets", "fonts", "DejaVuSans-Bold.ttf"),
    path.join(process.cwd(), "assets", "fonts", "DejaVuSansCondensed.ttf"),
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
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#080A12");
  g.addColorStop(0.45, "#0B1024");
  g.addColorStop(1, "#12081A");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const v = ctx.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, Math.max(W, H) / 1.2);
  v.addColorStop(0, "rgba(255,255,255,0.03)");
  v.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);

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

    const u = String(bufOrUrl || "").trim();
    if (!u) return null;

    // Support data:image/png;base64,...
    if (isDataUrl(u)) {
      const parsed = parseDataUrl(u);
      if (!parsed?.buffer) return null;
      return await Canvas.loadImage(parsed.buffer);
    }

    // string URL -> buffer first for compatibility
    const b = await fetchBuffer(u, { timeoutMs: 14000 });
    if (!b) return null;
    return await Canvas.loadImage(b);
  } catch (e) {
    log("loadImage failed:", e?.message || e);
    return null;
  }
}

function normalizeChainKey(chain) {
  const c = String(chain || "").trim().toLowerCase();
  if (!c) return "base";
  if (c === "ethereum" || c === "eth" || c.includes("mainnet")) return "eth";
  if (c === "base" || c.includes("base")) return "base";
  if (c === "ape" || c.includes("ape")) return "ape";
  return c;
}

function normalizeReservoirChain(chainKey) {
  // Reservoir uses chain names like "ethereum" and "base"
  const c = normalizeChainKey(chainKey);
  if (c === "eth") return "ethereum";
  if (c === "base") return "base";
  return "ethereum";
}

function normalizeAddress(a) {
  const s = String(a || "").trim();
  if (!s) return null;
  return s.toLowerCase();
}

function normalizeTokenId(t) {
  const s = String(t ?? "").trim();
  if (!s) return null;
  // allow numeric or string
  return s;
}

async function fetchNftImageFromReservoir({ chain, contract, tokenId }) {
  if (!RESERVOIR_API_KEY) return null;

  const ch = normalizeReservoirChain(chain);
  const c = normalizeAddress(contract);
  const id = normalizeTokenId(tokenId);
  if (!c || !id) return null;

  const url =
    `${RESERVOIR_BASE_URL.replace(/\/+$/, "")}/tokens/v7?tokens=${c}:${encodeURIComponent(id)}`;

  const res = await safeFetch(url, {
    timeoutMs: 14000,
    headers: { "x-api-key": RESERVOIR_API_KEY, "accept": "application/json" },
  });

  if (!res) return null;

  try {
    const j = await res.json();
    const tok = j?.tokens?.[0]?.token || null;
    if (!tok) return null;

    // Try common image fields
    const img =
      tok.image ||
      tok.imageSmall ||
      tok.imageLarge ||
      tok.media ||
      tok?.collection?.image;

    if (img) return toHttpUrl(img);

    // Sometimes reservoir provides "media" object
    const media = tok?.media;
    if (media && typeof media === "string") return toHttpUrl(media);
    if (media && typeof media === "object") {
      const mimg = media.image || media.small || media.large || media.url;
      if (mimg) return toHttpUrl(mimg);
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchTokenUriOnChain({ chain, contract, tokenId }) {
  if (!ethers || !safeRpcCall) return null;

  const chainKey = normalizeChainKey(chain);
  const c = normalizeAddress(contract);
  const id = normalizeTokenId(tokenId);
  if (!c || !id) return null;

  // Only allow known chains you already run providers for
  const allowed = ["base", "eth"];
  if (!allowed.includes(chainKey)) return null;

  const provider = await safeRpcCall(chainKey, (p) => p).catch(() => null);
  if (!provider) return null;

  const abi = ["function tokenURI(uint256 tokenId) view returns (string)"];
  try {
    const nft = new ethers.Contract(c, abi, provider);
    const uri = await nft.tokenURI(id);
    return uri ? String(uri) : null;
  } catch (e) {
    log("tokenURI() failed:", chainKey, c, id, e?.message || e);
    return null;
  }
}

/**
 * Resolve NFT image:
 * - payload.image / image_url / imageUrl
 * - payload.metadataUrl -> JSON -> image fields
 * - payload.contract + tokenId:
 *    - reservoir (if RESERVOIR_API_KEY)
 *    - tokenURI() on-chain -> metadata -> image
 */
async function resolveNftImageUrl(payload) {
  if (!payload || typeof payload !== "object") return null;

  // Accept many key aliases (so you can type less in Discord)
  const direct =
    payload.image ||
    payload.image_url ||
    payload.imageUrl ||
    payload.imageURI ||
    payload.imageUri ||
    payload.img ||
    payload.png;

  if (direct) {
    const u = toHttpUrl(direct);
    log("NFT image direct:", u);
    return u;
  }

  const metaUrl =
    payload.metadataUrl ||
    payload.metadata_url ||
    payload.tokenUri ||
    payload.tokenURI ||
    payload.uri ||
    payload.meta;

  if (metaUrl) {
    const meta = await fetchJson(metaUrl, { timeoutMs: 14000 });
    if (meta && typeof meta === "object") {
      const img =
        meta.image ||
        meta.image_url ||
        meta.imageUrl ||
        meta.imageURI ||
        meta.imageUri ||
        (meta.metadata && (meta.metadata.image || meta.metadata.image_url)) ||
        (meta?.properties && meta?.properties?.image);
      if (img) {
        const u = toHttpUrl(img);
        log("NFT image from metadata:", u);
        return u;
      }
    }
  }

  // contract + tokenId auto resolve
  const contract =
    payload.contract ||
    payload.ca ||
    payload.address ||
    payload.collection ||
    payload.collectionAddress;

  const tokenId =
    payload.tokenId ||
    payload.token_id ||
    payload.id ||
    payload.token ||
    payload.tokenID;

  const chain = payload.chain || payload.network || payload.net || "base";

  if (contract && tokenId) {
    // 1) Reservoir
    const resImg = await fetchNftImageFromReservoir({ chain, contract, tokenId });
    if (resImg) {
      log("NFT image from Reservoir:", resImg);
      return resImg;
    }

    // 2) On-chain tokenURI
    const tokenUri = await fetchTokenUriOnChain({ chain, contract, tokenId });
    if (tokenUri) {
      log("tokenURI:", tokenUri);
      const meta = await fetchJson(tokenUri, { timeoutMs: 14000 });
      if (meta && typeof meta === "object") {
        const img =
          meta.image ||
          meta.image_url ||
          meta.imageUrl ||
          meta.imageURI ||
          meta.imageUri ||
          (meta.metadata && (meta.metadata.image || meta.metadata.image_url));
        if (img) {
          const u = toHttpUrl(img);
          log("NFT image from tokenURI metadata:", u);
          return u;
        }
      }
    }
  }

  return null;
}

/**
 * Resolve token logo:
 * - payload.logoUrl / logo_url / icon
 */
function resolveTokenLogoUrl(payload) {
  if (!payload || typeof payload !== "object") return null;
  const u =
    payload.logoUrl ||
    payload.logo_url ||
    payload.icon ||
    payload.iconUrl ||
    payload.image ||
    payload.imageUrl;
  return u ? toHttpUrl(u) : null;
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
}

/**
 * Main render function
 * @param {object} args
 * @returns { buffer, filename, contentType, resolvedImageUrl }
 */
async function renderGiftRevealCard(args = {}) {
  if (!Canvas?.createCanvas) {
    return { buffer: null, filename: null, contentType: null, resolvedImageUrl: null };
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

  // art area + text area
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
    if (payload?.image) imageUrl = toHttpUrl(payload.image);
  }

  log("resolvedImageUrl:", imageUrl);

  // Draw image if possible
  let imgDrawn = false;
  if (imageUrl) {
    const img = await tryLoadImage(imageUrl);
    if (img) {
      ctx.save();
      ctx.globalAlpha = 0.95;

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
    } else {
      log("image failed to load:", imageUrl);
    }
  }

  // placeholder icon if no image
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

    // tiny debug stamp (so you can tell it tried)
    if (DEBUG) {
      ctx.font = "500 16px DejaVuSans, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillText(`no image`, artX + 18, artY + 180);
    }

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
    const extraLine = [amount && symbol ? `${amount} ${symbol}` : "", chain ? `chain: ${chain}` : ""]
      .filter(Boolean)
      .join(" • ");

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

  // make filename slightly unique (Discord caching can be weird when filenames repeat)
  const nameSalt = sha1(`${Date.now()}_${Math.random()}_${prizeType}`);
  const filename = `gift-reveal-${nameSalt}.png`;

  return {
    buffer,
    filename,
    contentType: "image/png",
    resolvedImageUrl: imageUrl || null,
  };
}

module.exports = {
  renderGiftRevealCard,
  toHttpUrl,
};
