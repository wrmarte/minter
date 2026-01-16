// services/logScanner.js
// ======================================================
// fetchLogs() — resilient eth_getLogs helper
// - Safer provider handling (null-safe)
// - Uses providerM.safeRpcCall() so rotate/backoff happens automatically
// - Hard caps block span (small by default on Base to avoid rate limits)
// - Extra adaptive backoff when RPC says "over rate limit"
// ======================================================

const { id } = require("ethers");
const {
  getProvider,
  getMaxBatchSize,
  rotateProvider,
  safeRpcCall,
} = require("./providerM");

/* ===================== CONFIG ===================== */
// Smaller spans = fewer rate limits (Base endpoints are sensitive to eth_getLogs bursts)
const SPAN_BASE = Math.max(
  1,
  Number(process.env.LOGSCAN_BLOCK_SPAN_BASE || 2) // default 2 blocks per request
);
const SPAN_ETH = Math.max(
  1,
  Number(process.env.LOGSCAN_BLOCK_SPAN_ETH || 5) // default 5 blocks per request
);
const SPAN_APE = Math.max(
  1,
  Number(process.env.LOGSCAN_BLOCK_SPAN_APE || 2) // default 2 blocks per request
);

// Throttle between calls (ms)
const DELAY_BASE = Math.max(0, Number(process.env.LOGSCAN_DELAY_MS_BASE || 120));
const DELAY_ETH = Math.max(0, Number(process.env.LOGSCAN_DELAY_MS_ETH || 120));
const DELAY_APE = Math.max(0, Number(process.env.LOGSCAN_DELAY_MS_APE || 400));

// Extra delay when rate-limited (exponential-ish)
const RATE_LIMIT_BACKOFF_START = Math.max(
  250,
  Number(process.env.LOGSCAN_RL_BACKOFF_START_MS || 1000)
);
const RATE_LIMIT_BACKOFF_MAX = Math.max(
  RATE_LIMIT_BACKOFF_START,
  Number(process.env.LOGSCAN_RL_BACKOFF_MAX_MS || 60000)
);

// Optional jitter so multiple instances don’t spike at same time
const JITTER_MS = Math.max(0, Number(process.env.LOGSCAN_JITTER_MS || 120));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function withJitter(ms) {
  const j = JITTER_MS ? Math.floor(Math.random() * JITTER_MS) : 0;
  return Math.max(0, ms + j);
}

function isRateLimitMsg(msg) {
  const m = String(msg || "").toLowerCase();
  return (
    m.includes("over rate limit") ||
    m.includes("rate limit") ||
    m.includes("too many requests") ||
    m.includes("-32016") // Base often returns -32016 for rate limiting
  );
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

/* ===================== MAIN ===================== */

async function fetchLogs(addresses, fromBlock, toBlock, chain = "base") {
  const c = String(chain || "base").toLowerCase();

  // ✅ Only the canonical ERC-20 Transfer signature.
  // (The old "uint amount" signature is not valid and doubles calls)
  const topics = [id("Transfer(address,address,uint256)")];

  const logs = [];

  // Provider can be null early; safeRpcCall will self-heal & select/pin.
  // We still keep a light "exists" check for faster failure on totally dead chains.
  const quickProvider = getProvider(c);
  if (!quickProvider) {
    // Try a trivial safeRpcCall to force selection; if it fails, return empty safely.
    const forced = await safeRpcCall(c, (p) => p.getBlockNumber(), 2, 4000);
    if (forced == null) return [];
  }

  // This is NOT a block span; it’s an rpc batch size limiter in your providerM.
  // We’ll still respect it as a ceiling for our span choices.
  const maxSpanCeiling = Math.max(1, Number(getMaxBatchSize(c) || 1));

  let span = Math.min(defaultSpanForChain(c), maxSpanCeiling);

  // Adaptive rate-limit backoff state (per fetchLogs call)
  let rlBackoff = 0;

  for (const address of addresses) {
    if (!address) continue;

    for (const topic of topics) {
      let start = Number(fromBlock);

      while (start <= Number(toBlock)) {
        const end = Math.min(start + span - 1, Number(toBlock));

        const filter = {
          address,
          topics: [topic],
          fromBlock: start,
          toBlock: end,
        };

        try {
          // ✅ Use safeRpcCall so provider rotation/backoff happens inside providerM
          const theseLogs = await safeRpcCall(
            c,
            (p) => p.getLogs(filter),
            4,
            12000
          );

          if (Array.isArray(theseLogs) && theseLogs.length) {
            logs.push(...theseLogs);
          }

          // Success resets rate-limit backoff gradually
          if (rlBackoff > 0) {
            rlBackoff = Math.max(0, Math.floor(rlBackoff * 0.5));
          }
        } catch (err) {
          const msg = err?.info?.responseBody || err?.message || "";

          // Ape special-case (DRPC batch limit message variants)
          const isApeBatchLimit =
            c === "ape" &&
            (String(msg).includes("Batch of more than 3 requests") ||
              String(msg).includes("more than 3 requests"));

          if (isApeBatchLimit) {
            console.warn(
              `🛑 DRPC batch limit hit — ${c} logs skipped: ${start}–${end}`
            );
            return []; // Stop here instead of retrying
          }

          // Rate-limit detection -> rotate + backoff + reduce span
          if (isRateLimitMsg(msg)) {
            console.warn(
              `⏳ [${c}] RATE LIMITED on ${address} ${start}–${end} — rotating + backing off`
            );

            // rotate provider immediately (best effort)
            try {
              await rotateProvider(c);
            } catch {}

            // Increase backoff
            rlBackoff = Math.min(
              RATE_LIMIT_BACKOFF_MAX,
              Math.max(RATE_LIMIT_BACKOFF_START, rlBackoff ? rlBackoff * 2 : RATE_LIMIT_BACKOFF_START)
            );

            // Reduce span to be gentler (down to 1)
            span = Math.max(1, Math.min(span, 2) - 1);
          } else {
            console.warn(
              `⚠️ [${c}] Error fetching logs for ${address} ${start}–${end}: ${err?.message || err}`
            );
          }
        }

        // Advance window
        start = end + 1;

        // Base throttle + adaptive RL backoff
        const baseDelay = defaultDelayForChain(c);
        const extra = rlBackoff ? rlBackoff : 0;
        await sleep(withJitter(baseDelay + extra));
      }
    }
  }

  return logs;
}

module.exports = { fetchLogs };




