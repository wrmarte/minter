// listeners/mbella/media.js
// ======================================================
// GIF/Image selection (safe direct URLs only)
// ======================================================

const Utils = require("./utils");

// Minimal built-in fallback list (prefer env MBELLA_MEDIA_URLS)
const DEFAULT_MEDIA_URLS = [
  // Put your direct urls here (recommended), ex:
  // "romantic|https://.../kiss.gif",
  // "sass|https://.../smirk.gif",
  // "comfort|https://.../hug.gif",
  // "hype|https://.../lfg.gif",
  // "default|https://.../wink.gif",
].filter(Boolean);

function getMediaPool(Config) {
  const pool = (Config.MBELLA_MEDIA_URLS?.length ? Config.MBELLA_MEDIA_URLS : DEFAULT_MEDIA_URLS).filter(Boolean);
  // allow tagged "vibe|url" or plain urls
  return pool.filter((u) => {
    const raw = String(u || "").trim();
    const url = raw.includes("|") ? raw.split("|").slice(1).join("|").trim() : raw;
    return /\.(gif|png|jpg|jpeg|webp)$/i.test(url);
  });
}

function pickMediaUrlByVibe({ Config, vibe }) {
  const pool = getMediaPool(Config);
  if (!pool.length) return "";

  const tagged = [];
  const plain = [];

  for (const raw of pool) {
    const parts = String(raw).split("|").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) tagged.push({ tag: parts[0].toLowerCase(), url: parts.slice(1).join("|") });
    else plain.push(raw);
  }

  const v = String(vibe || "default").toLowerCase();
  const candidates = tagged.filter((x) => x.tag === v).map((x) => x.url).filter(Boolean);
  const use = candidates.length ? candidates : plain.length ? plain : tagged.map((x) => x.url);

  if (!use.length) return "";
  return use[Math.floor(Math.random() * use.length)];
}

function shouldAttachMedia({ Config, vibe, intensity, godMode }) {
  if (String(Config.MBELLA_MEDIA_MODE || "auto").toLowerCase() === "off") return false;

  const base = Number(Config.MBELLA_MEDIA_RATE_DEFAULT || 0.18);

  let p = base;
  if (String(Config.MBELLA_MEDIA_MODE || "auto").toLowerCase() === "on") p = Math.min(0.55, base + 0.18);
  if (vibe === "romantic") p += 0.10;
  if (vibe === "hype") p += 0.06;
  if (vibe === "comfort") p += 0.04;
  if (String(Config.MBELLA_SPICE || "").toLowerCase() === "feral") p += 0.05;
  if (Number(intensity) >= 4) p += 0.06;
  if (godMode) p += 0.04;

  p = Math.max(0, Math.min(0.75, p));
  return Utils.chance(p);
}

module.exports = {
  getMediaPool,
  pickMediaUrlByVibe,
  shouldAttachMedia,
};
