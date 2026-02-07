const fetch = require('node-fetch');

/* =========================================================
   ETH/USD PRICE (CoinGecko) — ENHANCED (NO LOGIC CHANGE)
   - Adds in-memory cache (TTL) to reduce API calls
   - Adds failure backoff so repeated failures don’t spam logs
   - Rate-limits the warning log line
   - Keeps the same fallback behavior ($3000) when CG fails
========================================================= */

// Cache TTL for successful price fetch (ms)
const ETH_USD_TTL_MS = Math.max(
  10_000,
  Number(process.env.ETH_USD_TTL_MS || 120_000) // default 2 minutes
);

// After a failure, don’t attempt again for this long (ms)
const ETH_USD_FAIL_BACKOFF_MS = Math.max(
  5_000,
  Number(process.env.ETH_USD_FAIL_BACKOFF_MS || 60_000) // default 60 seconds
);

// Rate-limit the CoinGecko warning log line (ms)
const ETH_USD_WARN_EVERY_MS = Math.max(
  0,
  Number(process.env.ETH_USD_WARN_EVERY_MS || 300_000) // default 5 minutes
);

// Optional fetch timeout (ms)
const ETH_USD_FETCH_TIMEOUT_MS = Math.max(
  2_000,
  Number(process.env.ETH_USD_FETCH_TIMEOUT_MS || 8_000) // default 8 seconds
);

// Fallback ETH price (same as before)
const ETH_USD_FALLBACK = Number(process.env.ETH_USD_FALLBACK || 3000);

let _ethUsdCache = {
  value: null,       // number
  fetchedAt: 0,      // ms
  lastFailAt: 0,     // ms
  inflight: null,    // Promise<number>|null
};

let _lastWarnAt = 0;
function warnRateLimited(msg) {
  const now = Date.now();
  if (ETH_USD_WARN_EVERY_MS <= 0 || now - _lastWarnAt >= ETH_USD_WARN_EVERY_MS) {
    _lastWarnAt = now;
    console.warn(msg);
  }
}

function isGoodNumber(n) {
  return Number.isFinite(n) && n > 0;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

async function fetchEthUsd() {
  const now = Date.now();

  // ✅ Serve from cache if fresh
  if (isGoodNumber(_ethUsdCache.value) && now - _ethUsdCache.fetchedAt <= ETH_USD_TTL_MS) {
    return _ethUsdCache.value;
  }

  // ✅ If we recently failed, avoid hammering CoinGecko; use fallback
  if (_ethUsdCache.lastFailAt && now - _ethUsdCache.lastFailAt < ETH_USD_FAIL_BACKOFF_MS) {
    return isGoodNumber(_ethUsdCache.value) ? _ethUsdCache.value : ETH_USD_FALLBACK;
  }

  // ✅ Deduplicate concurrent calls
  if (_ethUsdCache.inflight) {
    try {
      const v = await _ethUsdCache.inflight;
      if (isGoodNumber(v)) return v;
    } catch {
      // fall through to fallback
    }
    return isGoodNumber(_ethUsdCache.value) ? _ethUsdCache.value : ETH_USD_FALLBACK;
  }

  _ethUsdCache.inflight = (async () => {
    try {
      const { ok, status, data } = await fetchJsonWithTimeout(
        'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
        ETH_USD_FETCH_TIMEOUT_MS
      );

      const ethUSD = parseFloat(data?.ethereum?.usd || '0');
      if (!ok || !isGoodNumber(ethUSD)) {
        throw new Error(`Invalid ETH price (status=${status || 'n/a'} value=${ethUSD || 0})`);
      }

      _ethUsdCache.value = ethUSD;
      _ethUsdCache.fetchedAt = Date.now();
      _ethUsdCache.lastFailAt = 0;
      return ethUSD;
    } catch (e) {
      _ethUsdCache.lastFailAt = Date.now();

      // Keep same message, but rate-limited
      warnRateLimited(`⚠️ CoinGecko ETH price failed, using fallback: $${ETH_USD_FALLBACK}`);

      // Keep same behavior: return fallback when CG fails
      return ETH_USD_FALLBACK;
    } finally {
      _ethUsdCache.inflight = null;
    }
  })();

  return _ethUsdCache.inflight;
}

async function getRealDexPriceForToken(amount, tokenAddress) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}`);
    const data = await res.json();
    const priceData = data?.data?.attributes;

    const priceUSD = parseFloat(priceData?.price_usd || '0');
    if (!priceUSD || isNaN(priceUSD)) {
      console.warn(`⚠️ Invalid priceUSD for ${tokenAddress}:`, priceUSD);
      return null;
    }

    const ethUSD = await fetchEthUsd();
    const priceETH = priceUSD / ethUSD;
    const totalETH = amount * priceETH;

    console.log(`📊 Token ${tokenAddress} amount ${amount} → ${totalETH.toFixed(6)} ETH @ ${priceETH.toFixed(8)} ETH/unit`);
    return totalETH;
  } catch (err) {
    console.warn(`❌ Error in getRealDexPriceForToken(${tokenAddress}):`, err);
    return null;
  }
}

async function getEthPriceFromToken(tokenAddress) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}`);
    const data = await res.json();
    const attr = data?.data?.attributes;

    const fdv = parseFloat(attr?.fdv_usd || '0');
    const supply = parseFloat(attr?.total_supply || '0');

    if (!fdv || !supply || isNaN(fdv) || isNaN(supply)) {
      console.warn(`⚠️ Invalid fallback FDV/supply for ${tokenAddress}`);
      return null;
    }

    const priceUSD = fdv / supply;
    const ethUSD = await fetchEthUsd();

    const fallbackETH = priceUSD / ethUSD;
    console.log(`📉 Fallback Token ${tokenAddress} → ${fallbackETH.toFixed(8)} ETH/unit`);
    return fallbackETH;
  } catch (err) {
    console.warn(`❌ Error in getEthPriceFromToken(${tokenAddress}):`, err);
    return null;
  }
}

module.exports = { getRealDexPriceForToken, getEthPriceFromToken };
