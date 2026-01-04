// listeners/mbella/memory.js
// ======================================================
// In-memory convo memory per channel/user
// ======================================================

const bellaMemory = new Map(); // key -> { exp, items: [{role, text, ts}] }

function memKey(channelId, userId) {
  return `${channelId}:${userId || "any"}`;
}

function pushMemory(key, role, text, Config) {
  const now = Date.now();
  const ttl = Number(Config?.MBELLA_MEM_TTL_MS || 45 * 60 * 1000);

  const rec = bellaMemory.get(key) || { exp: now + ttl, items: [] };
  rec.exp = now + ttl;
  rec.items.push({ role, text: String(text || "").trim().slice(0, 900), ts: now });

  if (rec.items.length > 14) rec.items = rec.items.slice(rec.items.length - 14);
  bellaMemory.set(key, rec);
}

function getMemoryContext(key, Config) {
  const rec = bellaMemory.get(key);
  if (!rec) return "";
  if (Date.now() > rec.exp) {
    bellaMemory.delete(key);
    return "";
  }

  const lines = rec.items
    .filter((x) => x.text)
    .slice(-10)
    .map((x) => (x.role === "bella" ? `MBella: ${x.text}` : `User: ${x.text}`));

  if (!lines.length) return "";
  return `Private channel memory (recent turns; keep consistent tone & facts):\n${lines.join("\n")}`.slice(0, 1600);
}

module.exports = {
  memKey,
  pushMemory,
  getMemoryContext,
};
