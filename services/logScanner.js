// services/logScanner.js
// ======================================================
// fetchLogs() — resilient eth_getLogs helper
// - Null-safe provider handling
// - Small block spans (per-chain defaults) to avoid "no response" + rate limits
// - Per-chunk retries w/ timeout + adaptive backoff
// - Uses providerM rotation/pinning (getProvider + rotateProvider + safeRpcCall)
// ======================================================

const { id } = require("ethers");
const { getProvider, rotateProvider, safeRpcCall } = require("./providerM");

/* ===================== CONFIG ===================== */
// Smaller spans = fewer rate limits / fewer "no response" on getLogs
const SPAN_BASE = Math.max(1, Number(process.env.LOGSCAN_BLOCK_SPAN_BASE || 2)); // default 2
const SPAN_ETH = Math.max(1, Number(process.env.LOGSCAN_BLOCK_SPAN_ETH || 4)); // default 4
const SPAN_APE = Math.max(1, Number(process.env.LOGSCAN_BLOCK_SPAN_APE || 2)); // default 2

// Throttle between calls (ms)
const DELAY_BASE = Math.max(0, Number(process.env.LOGSCAN_DELAY_MS_BASE || 140));
const DELAY_ETH = Math.max(0, Number(process.env.LOGSCAN_DELAY_MS_ETH || 180));
const DELAY_APE = Math.max(0, Number(process.env.LOGSCAN_DELAY_MS_APE || 350));

// Per-chunk getLogs timeout (ms)
const LOGS_TIMEOUT_MS = Math.max(4000, Number(process.env.LOGSCAN_GETLOGS_TIMEOUT_MS || 12000));

// Per-chunk retries (in addition to providerM internals)
const CHUNK_RETRIES = Math.max(0, Number(process.env.LOGSCAN_CHUNK_RETRIES || 2));

// Extra delay when rate-limited (exponential-ish)
const RATE_LIMIT_BACKOFF_START = Math.max(250, Number(process.env.LOGSCAN_RL_BACKOFF_START_MS || 1000));
const RATE_LIMIT_BACKOFF_MAX = Math.max(RATE_LIMIT_BACKOFF_START, Number(process.env.LOGSCAN_RL_BACKOFF_MAX_MS || 60000));

// Optional jitter so multiple instances don’t spike at same time
const JITTER_MS = Math.max(0, Number(process.env.LOGSCAN_JITTER_MS || 120));

// Adaptive span growth control (safe)
const SPAN_GROW_EVERY = Math.max(1, Number(process.env.LOGSCAN_SPAN_GROW_EVERY || 8)); // after N consecutive successes
const SPAN_GROW_MAX_MULT = Math.max(1, Number(process.env.LOGSCAN_SPAN_GROW_MAX_MULT || 4)); // max = defaultSpan * mult

// Log spam control (safe)
const WARN_EVERY_MS = Math.max(0, Number(process.env.LOGSCAN_WARN_EVERY_MS || 15000)); // 15s per unique key
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

// ---- warn rate limit buckets ----
const _warnRL = new Map(); // key -> lastMs
function warnEvery(key, everyMs, line) {
  const ms = Math.max(0, Number(everyMs || 0));
  if (!ms) {
    console.warn(line);
    return;
  }
  const now = Date.now();
  const last = _warnRL.get(key) || 0;
  if (now - last < ms) return;
  _warnRL.set(key, now);
  console.warn(line);
}

function isRateLimitMsg(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("over rate limit") ||
    m.includes("rate limit") ||
    m.includes("too many requests") ||
    m.includes("-32016") || // Base often returns -32016 for RL
    m.includes("429") ||
    m.includes("no backend is currently healthy") // seen on Base sometimes
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
    m.includes("bad gateway") ||
    m.includes("aborted") ||
    m.includes("connection terminated unexpectedly")
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

// Force providerM to pin/select something for the chain if none pinned yet
async function ensureProviderPinned(chain) {
  const c = String(chain || "base").toLowerCase();

  const p0 = getProvider(c);
  if (p0) return true;

  // Kick providerM selection by doing a tiny safeRpcCall
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

  // Span starts at per-chain default; grows slowly on success, shrinks quickly on failures
  const defaultSpan = Math.max(1, defaultSpanForChain(c));
  const maxSpan = Math.max(defaultSpan, defaultSpan * SPAN_GROW_MAX_MULT);
  let span = defaultSpan;

  // Adaptive rate-limit backoff state (per fetchLogs call)
  let rlBackoff = 0;

  // Success tracking for gradual span growth
  let successStreak = 0;

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
      let rotatedThisChunk = false;

      for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
        // If provider dropped, try to re-pin
        let provider = getProvider(c);
        if (!provider) {
          const ok = await ensureProviderPinned(c);
          provider = ok ? getProvider(c) : null;
        }

        if (!provider) {
          lastErrMsg = "no provider available";
          if (!rotatedThisChunk) {
            rotatedThisChunk = true;
            try {
              await rotateProvider(c);
            } catch {}
          }
          await sleep(withJitter(400 + attempt * 250));
          continue;
        }

        try {
          // ✅ Use safeRpcCall so providerM handles rotation/timeouts consistently.
          // Still respects your CHUNK_RETRIES outer loop.
          const theseLogs =
            (await safeRpcCall(
              c,
              (p) => p.getLogs(filter),
              1, // keep outer retries authoritative
              LOGS_TIMEOUT_MS
            )) || [];

          got = Array.isArray(theseLogs) ? theseLogs : [];
          break; // success
        } catch (err) {
          const msg = err?.info?.responseBody || err?.message || String(err);
          lastErrMsg = msg;

          // Ape special-case: stop early (don’t spam)
          if (isApeBatchLimit(msg, c)) {
            warnEvery(
              `apeBatch:${address}`,
              WARN_EVERY_MS,
              `🛑 DRPC batch limit hit — ${c} logs skipped: ${start}–${end}`
            );
            return [];
          }

          const rateLimited = isRateLimitMsg(msg);
          const noResponse = isNoResponseMsg(msg);

          if (rateLimited) {
            warnEvery(
              `rl:${c}:${address}`,
              WARN_EVERY_MS,
              `⏳ [${c}] RATE LIMITED on ${address} ${start}–${end} — rotate + backoff`
            );

            if (!rotatedThisChunk) {
              rotatedThisChunk = true;
              try {
                await rotateProvider(c);
              } catch {}
            }

            // Increase backoff
            rlBackoff = Math.min(
              RATE_LIMIT_BACKOFF_MAX,
              Math.max(RATE_LIMIT_BACKOFF_START, rlBackoff ? rlBackoff * 2 : RATE_LIMIT_BACKOFF_START)
            );

            // Reduce span (down to 1)
            span = Math.max(1, span - 1);
            successStreak = 0;
          } else if (noResponse) {
            warnEvery(
              `nr:${c}:${address}`,
              WARN_EVERY_MS,
              `⚠️ [${c}] NO RESPONSE on ${address} ${start}–${end} — rotate + smaller span`
            );

            if (!rotatedThisChunk) {
              rotatedThisChunk = true;
              try {
                await rotateProvider(c);
              } catch {}
            }

            // Shrink span modestly (helps a lot)
            span = Math.max(1, Math.min(span, 2));
            rlBackoff = Math.min(RATE_LIMIT_BACKOFF_MAX, Math.max(rlBackoff, 800));
            successStreak = 0;
          } else {
            warnEvery(
              `err:${c}:${address}`,
              WARN_EVERY_MS,
              `⚠️ [${c}] getLogs error ${address} ${start}–${end}: ${String(msg).slice(0, 180)}`
            );

            if (!rotatedThisChunk) {
              rotatedThisChunk = true;
              try {
                await rotateProvider(c);
              } catch {}
            }
            successStreak = 0;
          }

          // Per-attempt delay
          await sleep(withJitter(300 + attempt * 450));
        }
      }

      if (got && got.length) logs.push(...got);

      if (!got) {
        // If we never got logs after retries, just move on (don’t hard fail scanners)
        warnEvery(
          `skipped:${c}:${address}:${start}:${end}`,
          WARN_EVERY_MS,
          `⚠️ [${c}] logs skipped for ${address} ${start}–${end} (after retries): ${String(lastErrMsg).slice(0, 180)}`
        );
      } else {
        // Success reduces backoff gradually
        if (rlBackoff > 0) rlBackoff = Math.max(0, Math.floor(rlBackoff * 0.5));

        // Grow span slowly after a streak of clean chunks
        successStreak += 1;
        if (successStreak >= SPAN_GROW_EVERY && span < maxSpan) {
          span = Math.min(maxSpan, span + 1);
          successStreak = 0;
          log(`span grown -> ${span} (chain=${c})`);
        }
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





