const { Interface, ethers } = require('ethers');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

// ================= CONFIG =================
const ENGINE_CONTRACT =
  '0x0351f7cba83277e891d4a85da498a7eacd764d58'.toLowerCase();

const POLL_MS         = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK_BLOCKS = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 30);

const DEBUG = String(process.env.SWEEP_DEBUG || '').trim() === '1';
const BOOT_PING = String(process.env.SWEEP_BOOT_PING || '').trim() === '1';

const SWEEP_IMG =
  process.env.SWEEP_IMG || 'https://iili.io/3tSecKP.gif';

// ================= CHECKPOINT =================
const CHECKPOINT_CHAIN = 'base';
const CHECKPOINT_KEY   = 'engine_sweep_last_block';

let _checkpointReady = false;
async function ensureCheckpointTable(client) {
  if (_checkpointReady) return true;
  const pg = client.pg;
  if (!pg) return false;

  await pg.query(`
    CREATE TABLE IF NOT EXISTS sweep_checkpoints (
      chain TEXT NOT NULL,
      key   TEXT NOT NULL,
      value BIGINT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (chain, key)
    )
  `);
  _checkpointReady = true;
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
  await client.pg.query(
    `INSERT INTO sweep_checkpoints(chain, key, value)
     VALUES ($1,$2,$3)
     ON CONFLICT (chain,key)
     DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [CHECKPOINT_CHAIN, CHECKPOINT_KEY, Math.floor(block)]
  );
}

// ================= HELPERS =================
const ERC721_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
]);

const TRANSFER_TOPIC = ethers.id(
  'Transfer(address,address,uint256)'
);

function buildEmoji(count) {
  if (count >= 10) return '🐳🐳🐳';
  if (count >= 5)  return '🐳🐳';
  if (count >= 3)  return '🐳';
  return '🧹';
}

// ================= CHANNEL ROUTING =================
async function resolveChannels(client) {
  const out = [];
  const added = new Set();

  try {
    const res = await client.pg.query(`
      SELECT DISTINCT channel_id
      FROM tracked_tokens
      WHERE channel_id IS NOT NULL
        AND channel_id <> ''
    `);

    for (const r of res.rows) {
      const id = r.channel_id;
      if (added.has(id)) continue;

      let ch = client.channels.cache.get(id)
        || await client.channels.fetch(id).catch(() => null);

      if (!ch || !ch.isTextBased()) continue;
      out.push(ch);
      added.add(id);
    }
  } catch (e) {
    console.log('[SWEEP] channel resolve error:', e.message);
  }

  return out;
}

// ================= CORE =================
async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) return;

  await ensureCheckpointTable(client);

  const latest = await provider.getBlockNumber();
  let last = await getLastBlock(client);

  if (!last) last = Math.max(latest - 2, 0);
  const fromBlock = Math.max(last, latest - LOOKBACK_BLOCKS);
  const toBlock = latest;

  if (DEBUG)
    console.log(`[SWEEP] scan ${fromBlock} -> ${toBlock}`);

  let logs = [];
  try {
    logs = await provider.getLogs({
      address: ENGINE_CONTRACT,
      topics: [TRANSFER_TOPIC],
      fromBlock,
      toBlock
    });
  } catch (e) {
    console.log('[SWEEP] getLogs failed:', e.message);
    return;
  }

  // Group by tx hash
  const sweeps = new Map();

  for (const lg of logs) {
    let parsed;
    try { parsed = ERC721_IFACE.parseLog(lg); }
    catch { continue; }

    const tx = lg.transactionHash.toLowerCase();
    const from = parsed.args.from;
    const to = parsed.args.to;
    const tokenId = parsed.args.tokenId.toString();

    if (!sweeps.has(tx)) {
      sweeps.set(tx, {
        tx,
        buyer: to,
        seller: from,
        tokenIds: []
      });
    }

    sweeps.get(tx).tokenIds.push(tokenId);
  }

  const channels = await resolveChannels(client);

  for (const sweep of sweeps.values()) {
    const count = sweep.tokenIds.length;
    if (count === 0) continue;

    // 🔥 SALE-STYLE EMBED (seller INCLUDED)
    const embed = {
      title: `🖼️ NFT SOLD – Engine Sweep`,
      description: `**${count} NFT${count > 1 ? 's' : ''} just sold!**\n\n${buildEmoji(count)}`,
      image: { url: SWEEP_IMG },
      fields: [
        {
          name: '👤 Seller',
          value: shortWalletLink(sweep.seller),
          inline: true
        },
        {
          name: '🧑‍🚀 Buyer',
          value: shortWalletLink(sweep.buyer),
          inline: true
        },
        {
          name: '🎯 Token IDs',
          value: sweep.tokenIds.slice(0, 12).map(id => `#${id}`).join(', ') +
            (sweep.tokenIds.length > 12 ? ' …' : ''),
          inline: false
        }
      ],
      url: `https://basescan.org/tx/${sweep.tx}`,
      color: 0x3498db,
      footer: { text: 'Engine Sale • Powered by PimpsDev' },
      timestamp: new Date().toISOString()
    };

    for (const ch of channels) {
      await ch.send({ embeds: [embed] }).catch(() => {});
    }
  }

  await setLastBlock(client, toBlock);
}

// ================= START =================
function startEngineSweepNotifierBase(client) {
  if (global._engine_sweep_base) return;
  global._engine_sweep_base = true;

  console.log('🧹 Engine Sweep notifier started (Base)');

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
