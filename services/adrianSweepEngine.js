// services/adrianSweepEngine.js
// ======================================================
// ADRIAN → ENGINE Sweep Engine (GLOBAL)
// Watches $ADRIAN ERC-20 Transfer events where `to == ENGINE_CA`
// and accumulates sweep power using sweepPower sidecar.
// Exposes a STABLE snapshot API for MuscleMB.
//
// SOURCES (IMPORTANT):
// - Reads logs from the TOKEN contract (ADRIAN CA)
// - Detects inflow INTO ENGINE CA
// - Converts inflow → sweep power (accumulation + decay)
//
// ======================================================

const { Interface, ethers } = require("ethers");

// Try to load providerM safely
let providerM = null;
try {
  providerM = require("./providerM");
} catch {
  providerM = null;
}

// Sweep power sidecar
const { initSweepPower, applySweepPower } = require("./sweepPower");

// ================= CONFIG =================
const SWEEP_ENGINE_CHAIN = String(process.env.SWEEP_ENGINE_CHAIN || "base").trim().toLowerCase();

const ADRIAN_TOKEN_CA = String(
  process.env.ADRIAN_TOKEN_CA || "0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea"
).toLowerCase();

const ENGINE_CA = String(
  process.env.ENGINE_CA || "0x0351f7cba83277e891d4a85da498a7eacd764d58"
).toLowerCase();

const POLL_MS = Number(process.env.SWEEP_ENGINE_POLL_MS || 12000);
const LOOKBACK = Number(process.env.SWEEP_ENGINE_LOOKBACK_BLOCKS || 200);
const MAX_BLOCKS = Number(process.env.SWEEP_ENGINE_MAX_BLOCKS_PER_TICK || 50);
const DEBUG = String(process.env.SWEEP_ENGINE_DEBUG || "").trim() === "1";

const FALLBACK_RPC_URL = String(
  process.env.SWEEP_ENGINE_BASE_RPC_URL || process.env.BASE_RPC_URL || ""
).trim();

// ERC-20 Transfer topic
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// Minimal ERC-20 ABI
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// Log decoder
const TRANSFER_IFACE = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

// ================= HELPERS =================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowMs() {
  return Date.now();
}

function logDebug(...args) {
  if (DEBUG) console.log("[SWEEP-ENGINE]", ...args);
}

// ================= CHECKPOINT =================
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

// ================= PROVIDER =================
async function getProvider() {
  if (providerM && typeof providerM.getProvider === "function") {
    try {
      const p = await providerM.getProvider(SWEEP_ENGINE_CHAIN);
      if (p) return p;
    } catch {}
  }

  if (!FALLBACK_RPC_URL) {
    throw new Error("No provider available for sweep engine");
  }
  return new ethers.JsonRpcProvider(FALLBACK_RPC_URL);
}

async function safeGetBlockNumber(provider) {
  if (providerM?.safeRpcCall) {
    try {
      return await providerM.safeRpcCall(
        SWEEP_ENGINE_CHAIN,
        () => provider.getBlockNumber(),
        "sweepEngine.blockNumber"
      );
    } catch {}
  }
  return provider.getBlockNumber();
}

async function safeGetLogs(provider, filter) {
  if (providerM?.safeRpcCall) {
    try {
      return await providerM.safeRpcCall(
        SWEEP_ENGINE_CHAIN,
        () => provider.getLogs(filter),
        "sweepEngine.getLogs"
      );
    } catch {}
  }
  return provider.getLogs(filter);
}

// ================= TOKEN META =================
async function resolveTokenMeta(provider) {
  const token = new ethers.Contract(ADRIAN_TOKEN_CA, ERC20_ABI, provider);
  let decimals = 18;
  let symbol = "TOKEN";

  try { decimals = Number(await token.decimals()); } catch {}
  try { symbol = String(await token.symbol()); } catch {}

  return { decimals, symbol };
}

function decodeTransferLog(log) {
  try {
    const parsed = TRANSFER_IFACE.parseLog(log);
    return {
      from: String(parsed.args.from || "").toLowerCase(),
      to: String(parsed.args.to || "").toLowerCase(),
      value: BigInt(parsed.args.value?.toString?.() || parsed.args.value || 0),
    };
  } catch {
    return null;
  }
}

// ======================================================
// MAIN ENGINE
// ======================================================
async function startAdrianSweepEngine(client) {
  // 1️⃣ Ensure sweepPower tables
  await initSweepPower(client);

  // 2️⃣ Expose STABLE sweepPower API for readers (MuscleMB)
  if (!client.sweepPower) {
    client.sweepPower = {
      snapshot: null,
      getSnapshot: async () => client.sweepPower.snapshot,
    };
  }

  const provider = await getProvider();
  const { decimals, symbol } = await resolveTokenMeta(provider);

  logDebug("boot", {
    chain: SWEEP_ENGINE_CHAIN,
    token: ADRIAN_TOKEN_CA,
    engine: ENGINE_CA,
    symbol,
    decimals,
  });

  const checkpointKey = `adrian_engine_inflow:${ADRIAN_TOKEN_CA}:${ENGINE_CA}`;
  let lastBlock = 0;

  if (client.pg) {
    try {
      await ensureCheckpointTable(client.pg);
      lastBlock = await loadCheckpoint(client.pg, SWEEP_ENGINE_CHAIN, checkpointKey);
    } catch {}
  }

  try {
    const tip = await safeGetBlockNumber(provider);
    if (!lastBlock || lastBlock <= 0) {
      lastBlock = Math.max(0, tip - LOOKBACK);
    }
  } catch {}

  if (!client.__adrianSweepEngine) client.__adrianSweepEngine = {};
  client.__adrianSweepEngine.running = true;

  // ================= LOOP =================
  while (client.__adrianSweepEngine.running) {
    const loopStart = nowMs();

    try {
      const tip = await safeGetBlockNumber(provider);
      let fromBlock = Math.max(0, Number(lastBlock));
      let toBlock = tip;

      if (toBlock - fromBlock > MAX_BLOCKS) {
        toBlock = fromBlock + MAX_BLOCKS;
      }

      const filter = {
        address: ADRIAN_TOKEN_CA,
        fromBlock,
        toBlock,
        topics: [TRANSFER_TOPIC],
      };

      const logs = await safeGetLogs(provider, filter);

      for (const lg of logs) {
        const decoded = decodeTransferLog(lg);
        if (!decoded) continue;
        if (decoded.to !== ENGINE_CA) continue;

        const event = {
          type: "BUY",
          chain: SWEEP_ENGINE_CHAIN,
          buyer: decoded.from,
          token: {
            address: ADRIAN_TOKEN_CA,
            symbol,
            decimals,
          },
          tokenAmountRaw: decoded.value,
          tokenAmount: Number(ethers.formatUnits(decoded.value, decimals)),
          ethPaid: 0n,
          tx: { hash: lg.transactionHash },
          log: {
            blockNumber: lg.blockNumber,
            logIndex: lg.index,
          },
        };

        const result = await applySweepPower(client, [], event, { scope: "global" });

        if (result) {
          const snap = {
            kind: "adrian_engine_inflow",
            scope: "global",
            chain: SWEEP_ENGINE_CHAIN,

            tokenSymbol: symbol,
            tokenCA: ADRIAN_TOKEN_CA,
            engineCA: ENGINE_CA,

            power: Number(result.power || 0),
            delta: Number(result.delta || 0),
            total: Number(result.power || 0),

            lastTx: lg.transactionHash,
            lastBlock: lg.blockNumber,
            lastTs: Date.now(),
          };

          // ✅ Expose snapshot to all readers
          client.sweepPower.snapshot = snap;
          client.sweepPowerSnapshot = snap;
        }
      }

      lastBlock = toBlock + 1;

      if (client.pg) {
        try {
          await saveCheckpoint(client.pg, SWEEP_ENGINE_CHAIN, checkpointKey, lastBlock);
        } catch {}
      }
    } catch (e) {
      console.log("[SWEEP-ENGINE] tick error:", e?.message || e);
      await sleep(Math.max(2000, POLL_MS / 2));
    }

    const elapsed = nowMs() - loopStart;
    await sleep(Math.max(250, POLL_MS - elapsed));
  }

  logDebug("stopped");
}

function stopAdrianSweepEngine(client) {
  if (client.__adrianSweepEngine) {
    client.__adrianSweepEngine.running = false;
  }
}

module.exports = {
  startAdrianSweepEngine,
  stopAdrianSweepEngine,
};

