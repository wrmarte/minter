// services/adrianSweepEngine.js
// ======================================================
// ADRIAN → ENGINE Sweep Reader (GLOBAL)
// Watches $ADRIAN ERC-20 Transfer events where `to == ENGINE_CA`
// and updates a global "sweep power" snapshot for MuscleMB.
// - Reads logs from the TOKEN contract (NOT the engine contract).
// - Stores a live snapshot on `client.sweepPowerSnapshot`
// - Optionally persists checkpoint to Postgres (if client.pg exists)
//
// REQUIRED ENVS (recommended):
//   ADRIAN_TOKEN_CA=0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea
//   ENGINE_CA=0x0351f7cba83277e891d4a85da498a7eacd764d58
//
// OPTIONAL ENVS:
//   SWEEP_ENGINE_CHAIN=base
//   SWEEP_ENGINE_POLL_MS=12000
//   SWEEP_ENGINE_LOOKBACK_BLOCKS=200
//   SWEEP_ENGINE_MAX_BLOCKS_PER_TICK=50
//   SWEEP_ENGINE_DEBUG=1
//   SWEEP_ENGINE_BASE_RPC_URL=<fallback RPC if providerM is not available>
//
// ======================================================

const { Interface, ethers } = require("ethers");

// Prefer your existing providerM if present, but do NOT hard-crash if missing.
let providerM = null;
try {
  providerM = require("./providerM"); // same folder as services
} catch {
  providerM = null;
}

// Reuse your sweepPower sidecar (patched below to support token inflow)
const { initSweepPower, applySweepPower } = require("./sweepPower");

const SWEEP_ENGINE_CHAIN = String(process.env.SWEEP_ENGINE_CHAIN || "base").trim().toLowerCase();

const ADRIAN_TOKEN_CA = String(
  process.env.ADRIAN_TOKEN_CA || "0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea"
).trim().toLowerCase();

const ENGINE_CA = String(
  process.env.ENGINE_CA || "0x0351f7cba83277e891d4a85da498a7eacd764d58"
).trim().toLowerCase();

const POLL_MS = Number(process.env.SWEEP_ENGINE_POLL_MS || 12000);
const LOOKBACK = Number(process.env.SWEEP_ENGINE_LOOKBACK_BLOCKS || 200);
const MAX_BLOCKS = Number(process.env.SWEEP_ENGINE_MAX_BLOCKS_PER_TICK || 50);
const DEBUG = String(process.env.SWEEP_ENGINE_DEBUG || "").trim() === "1";

const FALLBACK_RPC_URL = String(process.env.SWEEP_ENGINE_BASE_RPC_URL || process.env.BASE_RPC_URL || "").trim();

// ERC-20 Transfer topic
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// ERC-20 ABI minimal
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// Interface for log decoding (Transfer)
const TRANSFER_IFACE = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowMs() {
  return Date.now();
}

function logDebug(...args) {
  if (DEBUG) console.log("[SWEEP-ENGINE]", ...args);
}

async function ensureCheckpointTable(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS sweep_engine_checkpoint (
      chain TEXT NOT NULL,
      key TEXT NOT NULL,
      last_block BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (chain, key)
    )
  `);
}

async function loadCheckpoint(pg, chain, key) {
  const r = await pg.query(
    `SELECT last_block FROM sweep_engine_checkpoint WHERE chain=$1 AND key=$2 LIMIT 1`,
    [chain, key]
  );
  if (!r.rows?.length) return 0;
  return Number(r.rows[0].last_block || 0);
}

async function saveCheckpoint(pg, chain, key, lastBlock) {
  await pg.query(
    `INSERT INTO sweep_engine_checkpoint(chain, key, last_block)
     VALUES ($1,$2,$3)
     ON CONFLICT (chain, key)
     DO UPDATE SET last_block=EXCLUDED.last_block, updated_at=now()`,
    [chain, key, Math.floor(Number(lastBlock) || 0)]
  );
}

async function getProvider(client) {
  // 1) If providerM exists and has getProvider, use it
  if (providerM && typeof providerM.getProvider === "function") {
    try {
      const p = await providerM.getProvider(SWEEP_ENGINE_CHAIN);
      if (p) return p;
    } catch (e) {
      logDebug("providerM.getProvider failed:", e?.message || e);
    }
  }

  // 2) If providerM exports a provider or baseProvider, try common names
  if (providerM) {
    const maybe =
      providerM.provider ||
      providerM.baseProvider ||
      providerM.rpcProvider ||
      providerM.getBaseProvider;
    if (typeof maybe === "function") {
      try {
        const p = await maybe();
        if (p) return p;
      } catch (e) {
        logDebug("providerM fallback fn failed:", e?.message || e);
      }
    } else if (maybe) {
      return maybe;
    }
  }

  // 3) Fallback RPC URL (last resort)
  if (!FALLBACK_RPC_URL) {
    throw new Error(
      "No provider available. Provide providerM.getProvider('base') OR set SWEEP_ENGINE_BASE_RPC_URL/BASE_RPC_URL."
    );
  }
  return new ethers.JsonRpcProvider(FALLBACK_RPC_URL);
}

async function safeGetLogs(provider, filter) {
  // If your providerM has safeRpcCall, use it. Otherwise call directly.
  if (providerM && typeof providerM.safeRpcCall === "function") {
    // Try a few common signatures safely
    try {
      // signature A: safeRpcCall(chain, fn, label)
      return await providerM.safeRpcCall(SWEEP_ENGINE_CHAIN, () => provider.getLogs(filter), "sweepEngine.getLogs");
    } catch (_) {}
    try {
      // signature B: safeRpcCall(fn, label)
      return await providerM.safeRpcCall(() => provider.getLogs(filter), "sweepEngine.getLogs");
    } catch (_) {}
    try {
      // signature C: safeRpcCall(provider, fn, label)
      return await providerM.safeRpcCall(provider, () => provider.getLogs(filter), "sweepEngine.getLogs");
    } catch (_) {}
  }
  return await provider.getLogs(filter);
}

async function safeGetBlockNumber(provider) {
  if (providerM && typeof providerM.safeRpcCall === "function") {
    try {
      return await providerM.safeRpcCall(SWEEP_ENGINE_CHAIN, () => provider.getBlockNumber(), "sweepEngine.blockNumber");
    } catch (_) {}
    try {
      return await providerM.safeRpcCall(() => provider.getBlockNumber(), "sweepEngine.blockNumber");
    } catch (_) {}
    try {
      return await providerM.safeRpcCall(provider, () => provider.getBlockNumber(), "sweepEngine.blockNumber");
    } catch (_) {}
  }
  return await provider.getBlockNumber();
}

async function resolveTokenMeta(provider) {
  const token = new ethers.Contract(ADRIAN_TOKEN_CA, ERC20_ABI, provider);

  let decimals = 18;
  let symbol = "TOKEN";
  try {
    decimals = Number(await token.decimals());
  } catch {}
  try {
    symbol = String(await token.symbol());
  } catch {}

  return { decimals, symbol };
}

function decodeTransferLog(log) {
  try {
    const parsed = TRANSFER_IFACE.parseLog(log);
    const from = String(parsed.args.from || "").toLowerCase();
    const to = String(parsed.args.to || "").toLowerCase();
    const value = BigInt(parsed.args.value?.toString?.() || parsed.args.value || 0);
    return { from, to, value };
  } catch {
    return null;
  }
}

/**
 * Start the sweep engine loop (GLOBAL).
 * Stores live snapshot at `client.sweepPowerSnapshot`.
 */
async function startAdrianSweepEngine(client) {
  // Initialize sweepPower tables (safe, never crashes)
  await initSweepPower(client);

  const provider = await getProvider(client);
  const { decimals, symbol } = await resolveTokenMeta(provider);

  logDebug("boot", {
    chain: SWEEP_ENGINE_CHAIN,
    token: ADRIAN_TOKEN_CA,
    engine: ENGINE_CA,
    decimals,
    symbol,
    pollMs: POLL_MS,
    lookback: LOOKBACK,
    maxBlocks: MAX_BLOCKS,
  });

  // Checkpoint handling
  const checkpointKey = `adrian_engine_inflow:${ADRIAN_TOKEN_CA}:${ENGINE_CA}`;
  let lastBlock = 0;

  if (client.pg) {
    try {
      await ensureCheckpointTable(client.pg);
      lastBlock = await loadCheckpoint(client.pg, SWEEP_ENGINE_CHAIN, checkpointKey);
    } catch (e) {
      console.log("[SWEEP-ENGINE] checkpoint table/load error:", e?.message || e);
      lastBlock = 0;
    }
  }

  // If no checkpoint, start near tip - lookback
  try {
    const tip = await safeGetBlockNumber(provider);
    if (!lastBlock || lastBlock <= 0) {
      lastBlock = Math.max(0, tip - LOOKBACK);
    }
  } catch (e) {
    console.log("[SWEEP-ENGINE] failed to get tip on boot:", e?.message || e);
  }

  // Keep a local running flag
  if (!client.__adrianSweepEngine) client.__adrianSweepEngine = { running: true };
  client.__adrianSweepEngine.running = true;

  // Main loop
  while (client.__adrianSweepEngine.running) {
    const loopStart = nowMs();

    try {
      const tip = await safeGetBlockNumber(provider);

      // Bound scan range
      let fromBlock = Math.max(0, Number(lastBlock || 0));
      let toBlock = tip;

      if (toBlock < fromBlock) {
        // chain reorg / weirdness, reset gently
        fromBlock = Math.max(0, tip - LOOKBACK);
        toBlock = tip;
      }

      // Don’t scan too many blocks in one tick
      if (toBlock - fromBlock > MAX_BLOCKS) {
        toBlock = fromBlock + MAX_BLOCKS;
      }

      // Filter Transfer logs on TOKEN contract, and topic "Transfer"
      // We'll filter by `to == ENGINE` after decoding.
      const filter = {
        address: ADRIAN_TOKEN_CA,
        fromBlock,
        toBlock,
        topics: [TRANSFER_TOPIC],
      };

      const logs = await safeGetLogs(provider, filter);

      let hits = 0;
      let totalInflowRaw = 0n;

      for (const lg of logs) {
        const decoded = decodeTransferLog(lg);
        if (!decoded) continue;

        // only inflow to engine
        if (decoded.to !== ENGINE_CA) continue;

        hits += 1;
        totalInflowRaw += decoded.value;

        // Build an "event" compatible with sweepPower.applySweepPower()
        // We mark type BUY, but power calc will use tokenAmount if present (patched sweepPower.js).
        const event = {
          type: "BUY",
          chain: SWEEP_ENGINE_CHAIN,
          token: {
            address: ADRIAN_TOKEN_CA,
            symbol,
            decimals,
          },
          // From/To represent token transfer endpoints
          buyer: decoded.from,
          to: decoded.to,

          // token amount as raw + formatted
          tokenAmountRaw: decoded.value,
          tokenAmount: Number(ethers.formatUnits(decoded.value, decimals)), // safe for typical sizes; snapshot will also store raw

          // For compatibility with previous code paths:
          ethPaid: 0n,
          tx: { hash: lg.transactionHash },
          log: {
            blockNumber: lg.blockNumber,
            txIndex: lg.transactionIndex,
            logIndex: lg.index,
          },
        };

        // Update sweep power (GLOBAL scope)
        const result = await applySweepPower(client, [], event, { scope: "global" });

        // Update a live snapshot for MuscleMB reader (always, even if result null)
        const power = result?.power ?? client?.sweepPowerSnapshot?.power ?? 0;
        const delta = result?.delta ?? 0;

        client.sweepPowerSnapshot = {
          kind: "adrian_engine_inflow",
          scope: "global",
          chain: SWEEP_ENGINE_CHAIN,
          tokenSymbol: symbol,
          tokenCA: ADRIAN_TOKEN_CA,
          engineCA: ENGINE_CA,

          power: Number(power || 0),
          delta: Number(delta || 0),

          lastInflowRaw: decoded.value.toString(),
          lastInflow: Number(ethers.formatUnits(decoded.value, decimals)),

          lastTx: lg.transactionHash,
          lastBlock: lg.blockNumber,

          updatedAt: Date.now(),
        };
      }

      // Move checkpoint forward
      lastBlock = toBlock + 1;

      if (client.pg) {
        try {
          await saveCheckpoint(client.pg, SWEEP_ENGINE_CHAIN, checkpointKey, lastBlock);
        } catch (e) {
          console.log("[SWEEP-ENGINE] checkpoint save error:", e?.message || e);
        }
      }

      if (DEBUG && (hits > 0 || (toBlock % 50 === 0))) {
        const totalFmt = Number(ethers.formatUnits(totalInflowRaw, decimals));
        logDebug(`scan ${fromBlock}..${toBlock} hits=${hits} inflow=${totalFmt} ${symbol} next=${lastBlock}`);
      }
    } catch (e) {
      console.log("[SWEEP-ENGINE] tick error:", e?.message || e);
      // Don’t spin tight on errors
      await sleep(Math.max(2000, Math.floor(POLL_MS / 2)));
    }

    // Sleep until next tick (respect POLL_MS)
    const elapsed = nowMs() - loopStart;
    const wait = Math.max(250, POLL_MS - elapsed);
    await sleep(wait);
  }

  logDebug("stopped");
}

function stopAdrianSweepEngine(client) {
  if (client.__adrianSweepEngine) client.__adrianSweepEngine.running = false;
}

module.exports = {
  startAdrianSweepEngine,
  stopAdrianSweepEngine,
};
