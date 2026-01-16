// services/logScanner.js
// ======================================================
// fetchLogs() — resilient eth_getLogs helper
// - Null-safe provider handling
// - Small block spans (per-chain defaults) to avoid "no response" + rate limits
// - Per-chunk retries w/ timeout + adaptive backoff
// - Uses providerM rotation/pinning (getProvider + rotateProvider)
// ======================================================

const { id } = require("ethers");
const { getProvider, getMaxBatchSize, rotateProvider, safeRpcCall } = require("./providerM");

/* ===================== CONFIG ===================== */
// Smaller spans = fewer rate limits / fewer "no response" on getLogs
const SPAN_BASE = Math.max(1, Number(process.env.LOGSCAN_BLOCK_SPAN_BASE || 2)); // default 2
const SPAN_ETH  = Math.max(1, Number(process.env.LOGSCAN_BLOCK_SPAN_ETH  || 4)); // default 4 (safer than 5)
const SPAN_APE  = Math.max(1, Number(process.env.LOGSCAN_BLOCK_SPAN_APE  || 2)); // default 2

// Throttle between calls (ms)
const DELAY_BASE = Math.max(0, Number(process.env.LOGSCAN_DELAY_MS_BASE || 140));
const DELAY_ETH  = Math.max(0, Number(process.env.LOGSCAN_DELAY_MS_ETH  || 180));
const DELAY_APE  = Math.max(0, Number(process.env.LOGSCAN_DELAY_MS_APE  || 350));

// Per-chunk getLogs timeout (ms)
const LOGS_TIMEOUT_MS = Math.max(4000, Number(process.env.LOGSCAN_GETLOGS_TIMEOUT_MS || 12000));

// Per-chunk retries (in addition to providerM internals)
const CHUNK_RETRIES = Math.max(0, Number(process.env.LOGSCAN_CHUNK_RETRIES || 2));

// Extra delay when rate-limited (exponential-ish)
const RATE_LIMIT_BACKOFF_START = Math.max(250, Number(process.env.LOGSCAN_RL_BACKOFF_START_MS || 1000));
const RATE_LIMIT_BACKOFF_MAX   = Math.max(RATE_LIMIT_BACKOFF_START, Number(process.env.LOGSCAN_RL_BACKOFF_MAX_MS || 60000));

// Optional jitter so multiple instances don’t spike at same time
const JITTER_MS = Math.max(0, Number(process.env.LOGSCAN_JITTER_MS || 120));

// Debug
const DEBUG = String(process.env.LOGSCAN_DEBUG || "").trim() === "1";

function log(...args) {
  if (DEBUG) console.log("🧾 [logScanner]", ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function withJitter(ms) {
  const j = JITTER_MS ? Math.floor(Math.random() * JITTER_MS) : 0;
  return Math.max(0, ms + j);
}

function normalizeAddrs(addresses) {
  const arr = Array.isArray(addresses) ? addresses : [addresses];
  return arr
    .map((a) => String(a || "").trim().toLowerCase())
    .filter(Boolean);
}

function isRateLimitMsg(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("over rate limit") ||
    m.includes("rate limit") ||
    m.includes("too many requests") ||
    m.includes("-32016") || // Base often returns -32016 for RL
    m.includes("429")
  );
}

function isNoResponseMsg(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("no response") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("gateway timeout") ||
    m.includes("service unavailable") ||
    m.includes("bad gateway")
  );
}

function isApeBatchLimit(msg, chain) {
  if (String(chain || "").toLowerCase() !== "ape") return false;
  const m = String(msg || "");
  return m.includes("Batch of more than 3 requests") || m.includes("more than 3 requests");
}

function defaultSpanForChain(chain) {
  const c = String(chain || "base").toLowerCase();
  if (c === "ape") return SPAN_APE;
  if (c === "eth") return SPAN_ETH;
  return SPAN_BASE;
}

function defaultDelayForChain(chain) {
  const c = String(chain || "base").toLowerCase();
  if (c === "ape") return DELAY_APE;
  if (c === "eth") return DELAY_ETH;
  return DELAY_BASE;
}

function withTimeout(promise, ms, reason = "rpc call timeout") {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(reason));
    }, ms);

    Promise.resolve(promise)
      .then((v) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        reject(e);
      });
  });
}

// Force providerM to pin/select something for the chain if none pinned yet
async function ensureProviderPinned(chain) {
  const c = String(chain || "base").toLowerCase();

  // If already pinned, great
  const p0 = getProvider(c);
  if (p0) return true;

  // Kick providerM selection by doing a tiny safeRpcCall
  // NOTE: safeRpcCall returns null on failure; it doesn't throw
  const ok = await safeRpcCall(c, (p) => p.getBlockNumber(), 2, 4000);
  if (ok == null) return false;

  const p1 = getProvider(c);
  return Boolean(p1);
}

/* ===================== MAIN ===================== */

async function fetchLogs(addresses, fromBlock, toBlock, chain = "base") {
  const c = String(chain || "base").toLowerCase();

  // ✅ Only canonical Transfer signature
  const topicTransfer = id("Transfer(address,address,uint256)");

  const logs = [];
  const addrs = normalizeAddrs(addresses);

  if (!addrs.length) return [];
  const fb = Number(fromBlock);
  const tb = Number(toBlock);
  if (!Number.isFinite(fb) || !Number.isFinite(tb) || tb < fb) return [];

  // getMaxBatchSize() is NOT a block span, but we can use it as a ceiling hint
  const maxSpanCeiling = Math.max(1, Number(getMaxBatchSize(c) || 1));
  let span = Math.max(1, Math.min(defaultSpanForChain(c), maxSpanCeiling));

  // Adaptive rate-limit backoff state (per fetchLogs call)
  let rlBackoff = 0;

  // Ensure provider pinned before hammering getLogs
  const pinned = await ensureProviderPinned(c);
  if (!pinned) {
    log(`no provider pinned for chain=${c} (returning empty logs safely)`);
    return [];
  }

  for (const address of addrs) {
    let start = fb;

    while (start <= tb) {
      const end = Math.min(start + span - 1, tb);

      const filter = {
        address,
        topics: [topicTransfer],
        fromBlock: start,
        toBlock: end,
      };

      let got = null;
      let lastErrMsg = "";

      for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
        // Always use latest pinned provider
        let provider = getProvider(c);

        // If provider dropped, try to re-pin
        if (!provider) {
          const ok = await ensureProviderPinned(c);
          provider = ok ? getProvider(c) : null;
        }

        if (!provider) {
          lastErrMsg = "no provider available";
          // rotate and backoff
          try { await rotateProvider(c); } catch {}
          await sleep(withJitter(400 + attempt * 250));
          continue;
        }

        try {
          // Direct getLogs with our own timeout so we can detect messages
          const theseLogs = await withTimeout(provider.getLogs(filter), LOGS_TIMEOUT_MS, "rpc getLogs timeout");
          got = Array.isArray(theseLogs) ? theseLogs : [];
          break; // success
        } catch (err) {
          const msg = err?.info?.responseBody || err?.message || String(err);
          lastErrMsg = msg;

          // Ape special-case: stop early (don’t spam)
          if (isApeBatchLimit(msg, c)) {
            console.warn(`🛑 DRPC batch limit hit — ${c} logs skipped: ${start}–${end}`);
            return [];
          }

          const rateLimited = isRateLimitMsg(msg);
          const noResponse  = isNoResponseMsg(msg);

          if (rateLimited) {
            console.warn(`⏳ [${c}] RATE LIMITED on ${address} ${start}–${end} — rotate + backoff`);
            // rotate provider immediately
            try { await rotateProvider(c); } catch {}

            // Increase backoff
            rlBackoff = Math.min(
              RATE_LIMIT_BACKOFF_MAX,
              Math.max(
                RATE_LIMIT_BACKOFF_START,
                rlBackoff ? rlBackoff * 2 : RATE_LIMIT_BACKOFF_START
              )
            );

            // Reduce span (down to 1)
            span = Math.max(1, span - 1);
          } else if (noResponse) {
            console.warn(`⚠️ [${c}] NO RESPONSE on ${address} ${start}–${end} — rotate + smaller span`);
            try { await rotateProvider(c); } catch {}

            // Shrink span a bit (helps “no response” a lot)
            span = Math.max(1, Math.min(span, 2));
            // Mild backoff too
            rlBackoff = Math.min(RATE_LIMIT_BACKOFF_MAX, Math.max(rlBackoff, 800));
          } else {
            console.warn(`⚠️ [${c}] getLogs error ${address} ${start}–${end}: ${msg}`);
            // Rotate once for unknown errors too (best effort)
            try { await rotateProvider(c); } catch {}
          }

          // Per-attempt delay
          await sleep(withJitter(300 + attempt * 450));
        }
      }

      if (got && got.length) logs.push(...got);

      if (!got) {
        // If we never got logs after retries, just move on (don’t hard fail scanners)
        console.warn(`⚠️ [${c}] logs skipped for ${address} ${start}–${end} (after retries): ${String(lastErrMsg).slice(0, 180)}`);
      } else {
        // Success reduces backoff gradually
        if (rlBackoff > 0) rlBackoff = Math.max(0, Math.floor(rlBackoff * 0.5));
      }

      start = end + 1;

      // Throttle + adaptive backoff
      const baseDelay = defaultDelayForChain(c);
      await sleep(withJitter(baseDelay + (rlBackoff || 0)));
    }
  }

  return logs;
}

module.exports = { fetchLogs };





