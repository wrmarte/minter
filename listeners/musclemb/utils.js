// listeners/musclemb/utils.js
const fetch = require('node-fetch');

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const hasAbort = typeof globalThis.AbortController === 'function';
  if (hasAbort) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      const bodyText = await res.text();
      return { res, bodyText };
    } finally {
      clearTimeout(timer);
    }
  } else {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, opts);
        const bodyText = await res.text();
        return { res, bodyText };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeoutMs))
    ]);
  }
}

async function fetchBinaryWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const hasAbort = typeof globalThis.AbortController === 'function';
  if (hasAbort) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      let buf;
      if (typeof res.buffer === 'function') {
        buf = await res.buffer();
      } else {
        const ab = await res.arrayBuffer();
        buf = Buffer.from(ab);
      }
      return { res, buf };
    } finally {
      clearTimeout(timer);
    }
  } else {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, opts);
        let buf;
        if (typeof res.buffer === 'function') {
          buf = await res.buffer();
        } else {
          const ab = await res.arrayBuffer();
          buf = Buffer.from(ab);
        }
        return { res, buf };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeoutMs))
    ]);
  }
}

function makeRng(seedStr = "") {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = (h || 123456789) >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return (x >>> 0) / 0x100000000;
  };
}

function weightedPick(entries, rng = Math.random) {
  const total = entries.reduce((s, e) => s + Math.max(0, e.weight || 0), 0) || 1;
  let t = rng() * total;
  for (const e of entries) {
    const w = Math.max(0, e.weight || 0);
    if (t < w) return e.key;
    t -= w;
  }
  return entries[entries.length - 1]?.key;
}

function getDaypart(hour) {
  if (hour >= 0 && hour <= 5) return "late_night";
  if (hour <= 11) return "morning";
  if (hour <= 16) return "midday";
  if (hour <= 21) return "evening";
  return "late_evening";
}

function fmtMoney(n, decimals = 6) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  return `$${x.toFixed(decimals)}`;
}

function fmtNum(n, decimals = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  return x.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function fmtVol(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(2)}K`;
  return fmtNum(x, 2);
}

function fmtSigned(n, decimals = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  const sign = x > 0 ? '+' : '';
  return `${sign}${x.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}`;
}

function safeDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  if (String(d) === 'Invalid Date') return null;
  return d;
}

module.exports = {
  safeJsonParse,
  fetchWithTimeout,
  fetchBinaryWithTimeout,
  makeRng,
  weightedPick,
  getDaypart,
  fmtMoney,
  fmtNum,
  fmtVol,
  fmtSigned,
  safeDate,
};
