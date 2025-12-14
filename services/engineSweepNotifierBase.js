const { Interface, ethers } = require('ethers');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

// ================= CONFIG =================
const POLL_MS = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK_BLOCKS = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 40);
const MAX_BLOCKS_PER_TICK = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 10);
const MAX_TX_PER_BLOCK = Number(process.env.SWEEP_MAX_TX_PER_BLOCK || 200);

const DEBUG = String(process.env.SWEEP_DEBUG || '').trim() === '1';
const BOOT_PING = String(process.env.SWEEP_BOOT_PING || '').trim() === '1';

const SWEEP_IMG =
  process.env.SWEEP_IMG || 'https://iili.io/3tSecKP.gif';

// ================= CHECKPOINT =================
const CHECKPOINT_CHAIN = 'base';
const CHECKPOINT_KEY = 'engine_sweep_last_block';

let checkpointReady = false;

async function ensureCheckpointTable(client) {
  if (checkpointReady) return true;
  if (!client.pg) return false;

  await client.pg.query(`
    CREATE TABLE IF NOT EXISTS sweep_checkpoints (
      chain TEXT NOT NULL,
      key TEXT NOT NULL,
      value BIGINT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (chain, key)
    )
  `);

  checkpointReady = true;
  return true;
}

async function getLastBlock(client) {
  try {
    const res = await client.pg.query(
      `SELECT value FROM sweep_checkpoints WHERE chain=$1 AND key=$2`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY]
    );
    return res.rows?.[0]?.value ? Number(res.rows[0].value) : null;
  } catch {
    return null;
  }
}

async function setLastBlock(client, block) {
  try {
    await client.pg.query(
      `INSERT INTO sweep_checkpoints(chain,key,value)
       VALUES ($1,$2,$3)
       ON CONFLICT (chain,key)
       DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY, Math.floor(block)]
    );
  } catch {}
}

// ================= ERC721 =================
const ERC721_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
]);

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

function safeAddr(x) {
  try { return ethers.getAddress(x); } catch { return x || ''; }
}

function buildEmoji(count) {
  if (count >= 20) return '🐳🐳🐳🐳';
  if (count >= 10) return '🐳🐳🐳';
  if (count >= 5) return '🐳🐳';
  if (count >= 3) return '🐳';
  return '🧹';
}

function formatTokenIds(ids, max = 25) {
  const shown = ids.slice(0, max).map(id => `#${id}`).join(', ');
  return ids.length > max
    ? `${shown} … +${ids.length - max} more`
    : shown;
}

// ================= DEDUPE =================
const seenTx = new Map();

function markSeen(txh) {
  const now = Date.now();
  seenTx.set(txh, now);
  if (seenTx.size > 8000) {
    const cutoff = now - 6 * 60 * 60 * 1000;
    for (const [k, t] of seenTx.entries()) {
      if (t < cutoff) seenTx.delete(k);
    }
  }
}

function isSeen(txh) {
  return seenTx.has(txh);
}

// ================= CHANNEL ROUTING =================
async function resolveChannels(client) {
  const out = [];
  const added = new Set();

  if (!client.pg) return out;

  const res = await client.pg.query(`
    SELECT DISTINCT channel_id
    FROM tracked_tokens
    WHERE channel_id IS NOT NULL
      AND channel_id <> ''
  `);

  for (const row of res.rows || []) {
    const id = String(row.channel_id || '').trim();
    if (!id || added.has(id)) continue;

    let ch = client.channels.cache.get(id);
    if (!ch) ch = await client.channels.fetch(id).catch(() => null);
    if (!ch || !ch.isTextBased()) continue;

    out.push(ch);
    added.add(id);
  }

  return out;
}

// ================= CORE ANALYSIS =================
// OPTION A — PURE TRANSFER-PATTERN DETECTION
async function analyzeTxForSweep(provider, txHash) {
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!receipt) return null;

  const transfers = [];
  const tokenIds = [];
  const sellers = new Set();
  const buyers = new Set();

  for (const lg of receipt.logs || []) {
    if (lg.topics?.[0] !== TRANSFER_TOPIC || lg.topics.length < 4) continue;

    let parsed;
    try { parsed = ERC721_IFACE.parseLog(lg); } catch { continue; }

    const from = safeAddr(parsed.args.from);
    const to = safeAddr(parsed.args.to);
    const tokenId = parsed.args.tokenId?.toString?.();

    // Ignore mint/burn
    if (!tokenId || from === ethers.ZeroAddress) continue;

    transfers.push({ from, to, tokenId });
    tokenIds.push(tokenId);
    sellers.add(from);
    buyers.add(to);
  }

  // ✅ REAL SWEEP RULE
  if (transfers.length < 2) return null;

  return {
    txHash,
    tokenIds,
    sellers: [...sellers],
    buyers: [...buyers],
  };
}

// ================= SEND EMBED =================
async function sendSweepEmbed(client, data, channels) {
  if (!channels.length) return;

  const count = data.tokenIds.length;

  const embed = {
    title: `🧹 ENGINE SWEPT – ${count} NFT${count === 1 ? '' : 's'}`,
    description: `${buildEmoji(count)}\nTokens: ${formatTokenIds(data.tokenIds)}`,
    image: { url: SWEEP_IMG },
    fields: [
      {
        name: '👤 Seller',
        value:
          data.sellers.length === 1
            ? shortWalletLink(data.sellers[0])
            : `Multiple Sellers (${data.sellers.length})`,
        inline: true
      },
      {
        name: '🧑‍💻 Buyer',
        value:
          data.buyers.length === 1
            ? shortWalletLink(data.buyers[0])
            : `Multiple Buyers (${data.buyers.length})`,
        inline: true
      },
      {
        name: '💳 Method',
        value: 'ENGINE',
        inline: true
      }
    ],
    url: `https://basescan.org/tx/${data.txHash}`,
    color: 0xf1c40f,
    footer: { text: 'Engine Sweep Feed • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const ch of channels) {
    await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

// ================= BLOCK SCANNER =================
async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) return;

  await ensureCheckpointTable(client);

  const latest = await provider.getBlockNumber();
  let last = await getLastBlock(client);

  if (!last) last = Math.max(latest - 2, 0);

  let fromBlock = Math.max(last + 1, latest - LOOKBACK_BLOCKS);
  let toBlock = Math.min(fromBlock + MAX_BLOCKS_PER_TICK, latest);

  const channels = await resolveChannels(client);

  if (DEBUG)
    console.log(`[SWEEP] scan ${fromBlock} -> ${toBlock}`);

  for (let bn = fromBlock; bn <= toBlock; bn++) {
    const block = await provider.getBlock(bn, true).catch(() => null);
    if (!block?.transactions) continue;

    for (const tx of block.transactions.slice(0, MAX_TX_PER_BLOCK)) {
      const hash = (tx.hash || '').toLowerCase();
      if (!hash || isSeen(hash)) continue;
      markSeen(hash);

      const sweep = await analyzeTxForSweep(provider, hash);
      if (!sweep) continue;

      if (DEBUG)
        console.log(`[SWEEP] MATCH tx=${hash} nfts=${sweep.tokenIds.length}`);

      await sendSweepEmbed(client, sweep, channels);
    }
  }

  await setLastBlock(client, toBlock);
}

// ================= START =================
function startEngineSweepNotifierBase(client) {
  if (global._engine_sweep_base) return;
  global._engine_sweep_base = true;

  console.log(`🧹 Engine Sweep notifier started (Base)`);

  if (BOOT_PING) {
    resolveChannels(client).then(chs => {
      for (const ch of chs)
        ch.send('🧹 Engine Sweep notifier online.').catch(() => {});
    });
  }

  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };


