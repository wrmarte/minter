const { Interface, ethers } = require('ethers');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

// ================= CONFIG =================
const ENGINE_CONTRACT =
  '0x0351f7cba83277e891d4a85da498a7eacd764d58'.toLowerCase();

const POLL_MS = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK_BLOCKS = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 40);
const MAX_BLOCKS_PER_TICK = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 15);

const DEBUG = String(process.env.SWEEP_DEBUG || '') === '1';
const BOOT_PING = String(process.env.SWEEP_BOOT_PING || '') === '1';

const SWEEP_IMG =
  process.env.SWEEP_IMG || 'https://iili.io/3tSecKP.gif';

// ================= CHECKPOINT =================
const CHECKPOINT_CHAIN = 'base';
const CHECKPOINT_KEY = 'engine_sweep_last_block';

let checkpointReady = false;

async function ensureCheckpointTable(client) {
  if (checkpointReady) return true;
  const pg = client.pg;
  if (!pg) return false;

  await pg.query(`
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
      `
      INSERT INTO sweep_checkpoints(chain, key, value)
      VALUES ($1,$2,$3)
      ON CONFLICT (chain,key)
      DO UPDATE SET value=EXCLUDED.value, updated_at=now()
      `,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY, Math.floor(block)]
    );
  } catch {}
}

// ================= HELPERS =================
const ERC721_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
]);

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

function safeAddr(x) {
  try { return ethers.getAddress(x); } catch { return x || ''; }
}

function buildEmoji(n) {
  if (n >= 10) return '🐳🐳🐳';
  if (n >= 5) return '🐳🐳';
  if (n >= 3) return '🐳';
  return '🧹';
}

function formatTokenIds(ids, max = 20) {
  const out = ids.slice(0, max).map(id => `#${id}`).join(', ');
  return ids.length > max ? `${out} … +${ids.length - max}` : out;
}

// in-memory dedupe
const seenTx = new Map();
function markSeen(tx) {
  seenTx.set(tx, Date.now());
}
function isSeen(tx) {
  return seenTx.has(tx);
}

// ================= CHANNEL ROUTING =================
async function resolveChannels(client) {
  const out = [];
  const added = new Set();

  try {
    const res = await client.pg.query(`
      SELECT DISTINCT channel_id
      FROM tracked_tokens
      WHERE channel_id IS NOT NULL AND channel_id <> ''
    `);

    for (const r of res.rows || []) {
      const id = String(r.channel_id);
      if (added.has(id)) continue;

      let ch = client.channels.cache.get(id)
        || await client.channels.fetch(id).catch(() => null);

      if (!ch || !ch.isTextBased()) continue;

      out.push(ch);
      added.add(id);
    }
  } catch (e) {
    console.log('[ENGINE] channel resolve error:', e?.message);
  }

  return out;
}

// ================= CORE (OPTION A) =================
async function analyzeTx(provider, txHash) {
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  const tx = await provider.getTransaction(txHash).catch(() => null);
  if (!receipt || !tx) return null;

  let engineSeen = false;
  const tokenIds = [];
  const sellers = new Set();
  const buyers = new Set();

  for (const lg of receipt.logs || []) {
    const addr = (lg.address || '').toLowerCase();

    if (addr === ENGINE_CONTRACT) {
      engineSeen = true;
    }

    if (lg.topics?.[0] !== TRANSFER_TOPIC || lg.topics.length < 4) continue;

    let parsed;
    try { parsed = ERC721_IFACE.parseLog(lg); } catch { continue; }

    const from = safeAddr(parsed.args.from);
    const to = safeAddr(parsed.args.to);
    const tokenId = parsed.args.tokenId.toString();

    tokenIds.push(tokenId);
    sellers.add(from);
    buyers.add(to);

    if (
      from.toLowerCase() === ENGINE_CONTRACT ||
      to.toLowerCase() === ENGINE_CONTRACT
    ) {
      engineSeen = true;
    }
  }

  if (!engineSeen || tokenIds.length === 0) return null;

  return {
    txHash: txHash.toLowerCase(),
    buyer: safeAddr(tx.from),
    sellers: [...sellers],
    tokenIds
  };
}

async function sendEmbed(client, sweep, channels) {
  const count = sweep.tokenIds.length;

  const embed = {
    title: `🧹 ENGINE ${count > 1 ? 'SWEEP' : 'LISTING'}`,
    description: buildEmoji(count),
    image: { url: SWEEP_IMG },
    fields: [
      {
        name: 'NFTs',
        value: formatTokenIds(sweep.tokenIds, 25),
        inline: false
      },
      {
        name: 'Buyer',
        value: shortWalletLink(sweep.buyer),
        inline: true
      },
      {
        name: 'Method',
        value: 'ENGINE',
        inline: true
      }
    ],
    url: `https://basescan.org/tx/${sweep.txHash}`,
    color: 0xf1c40f,
    footer: { text: 'Engine Sweep Feed • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const ch of channels) {
    await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

// ================= TICK =================
async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) return;

  await ensureCheckpointTable(client);

  const latest = await provider.getBlockNumber();
  let last = await getLastBlock(client);

  if (!last) last = latest - 2;

  const from = Math.max(last + 1, latest - LOOKBACK_BLOCKS);
  const to = Math.min(from + MAX_BLOCKS_PER_TICK, latest);

  const channels = await resolveChannels(client);

  for (let bn = from; bn <= to; bn++) {
    const block = await provider.getBlock(bn, true).catch(() => null);
    if (!block?.transactions) continue;

    for (const tx of block.transactions) {
      const h = tx.hash.toLowerCase();
      if (isSeen(h)) continue;

      const sweep = await analyzeTx(provider, h);
      if (!sweep) continue;

      markSeen(h);
      if (channels.length) {
        await sendEmbed(client, sweep, channels);
      }

      if (DEBUG) {
        console.log(`[ENGINE] MATCH tx=${h} nfts=${sweep.tokenIds.length}`);
      }
    }
  }

  await setLastBlock(client, to);
}

// ================= START =================
function startEngineSweepNotifierBase(client) {
  if (global._engine_sweep_base) return;
  global._engine_sweep_base = true;

  console.log('🧹 Engine Sweep notifier started (Base)');
  if (BOOT_PING) {
    resolveChannels(client).then(chs => {
      for (const ch of chs) {
        ch.send('🧹 Engine Sweep notifier online.').catch(() => {});
      }
    });
  }

  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };

