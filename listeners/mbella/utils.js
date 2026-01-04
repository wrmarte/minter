// listeners/mbella/utils.js
// ======================================================
// Small shared helpers (no Discord imports)
// ======================================================

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rand = () => Math.random();
function chance(p) {
  const x = Number(p);
  if (!Number.isFinite(x)) return false;
  return rand() < Math.max(0, Math.min(1, x));
}

async function fetchWithTimeout(fetchImpl, url, opts = {}, timeoutMs = 25_000) {
  const hasAbort = typeof globalThis.AbortController === "function";
  if (hasAbort) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...opts, signal: controller.signal });
      const bodyText = await res.text();
      return { res, bodyText };
    } finally {
      clearTimeout(timer);
    }
  }

  return await Promise.race([
    (async () => {
      const res = await fetchImpl(url, opts);
      const bodyText = await res.text();
      return { res, bodyText };
    })(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout")), timeoutMs)),
  ]);
}

module.exports = {
  safeJsonParse,
  sleep,
  rand,
  chance,
  fetchWithTimeout,
};
