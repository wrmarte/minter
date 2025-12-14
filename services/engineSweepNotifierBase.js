const { Interface, ethers } = require('ethers');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

// ================= CONFIG =================
const ENGINE_CONTRACT =
  '0x0351f7cba83277e891d4a85da498a7eacd764d58'.toLowerCase();

const POLL_MS         = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK_BLOCKS = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 30);
const MAX_BLOCKS_PER_TICK = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 12); // safety cap

const DEBUG = String(process.env.SWEEP_DEBUG || '').trim() === '1';
const BOOT_PING = String(process.env.SWEEP_BOOT_PING || '').trim() === '1';

const SWEEP_IMG = process.env.SWEEP_IMG || 'https://iili.io/3tSecKP.gif';

// ================= CHECKPOINT =================
const CHECKPOINT_CHAIN = 'base';
const CHECKPOINT_KEY   = 'engine_sweep_last_block';

let _checkpointReady = false;
async function ensureCheckpointTable(client) {
  if (_checkpointReady) return true;
  const pg = client.pg;
  if (!pg) return false;

  try {
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
  } catch (e) {
    console.log(`[SWEEP] ensureCheckpointTable failed: ${e?.message || e}`);
    return false;
  }
}

async function getLastBlock(client) {
  try {
    const res = await client.pg.query(
      `SELECT value FROM sweep_checkpoints WHERE chain=$1 AND key=$2`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY]
    );
    const v = res.rows?.[0]?.value;
    return (v !== undefined && v !== null) ? Number(v) : null;
  } catch {
    return null;
  }
}

async function setLastBlock(client, block) {
  try {
    await client.pg.query(
      `INSERT INTO sweep_checkpoints(chain, key, value)
       VALUES ($1,$2,$3)
       ON CONFLICT (chain,key)
       DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY, Math.floor(Number(block))]
    );
  } catch {}
}

// ================= HELPERS =================
const ERC721_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
]);

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

function buildEmoji(count) {
  if (count >= 10) return '🐳🐳🐳';
  if (count >= 5)  return '🐳🐳';
  if (count >= 3)  return '🐳';
  return '🧹';
}

function safeAddr(x) {
  try { return ethers.getAddress(x); } catch { return x || ''; }
}

function addrEq(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
}

function formatTokenIds(tokenIds, max = 20) {
  const list = tokenIds.slice(0, max).map(id => `#${id}`).join(', ');
  if (tokenIds.length > max) return `${list} … +${tokenIds.length - max} more`;
  return list || 'N/A';
}

// In-memory dedupe (prevents double-posts within a run)
const seenTx = new Map();
function markSeen(txh) {
  const now = Date.now();
  seenTx.set(txh, now);
  if (seenTx.size > 5000) {
    const cutoff = now - 6 * 60 * 60 * 1000;
    for (const [k, ts] of seenTx.entries()) if (ts < cutoff) seenTx.delete(k);
  }
}
function isSeen(txh) { return seenTx.has(txh); }

// ================= CHANNEL ROUTING =================
// Uses same DB the mint/token tracker uses.
// Sends to any channel that has tracked_tokens.channel_id (you can tighten later if you want).
async function resolveChannels(client) {
  const out = [];
  const added = new Set();

  try {
    const pg = client.pg;
    if (!pg) return out;

    const res = await pg.query(`
      SELECT DISTINCT channel_id
      FROM tracked_tokens
      WHERE channel_id IS NOT NULL
        AND channel_id <> ''
    `);

    for (const r of (res.rows || [])) {
      const id = String(r.channel_id || '').trim();
      if (!id || added.has(id)) continue;

      let ch = client.channels.cache.get(id) || null;
      if (!ch) ch = await client.channels.fetch(id).catch(() => null);
      if (!ch || (typeof ch.isTextBased === 'function' && !ch.isTextBased())) continue;

      // basic permission safety
      try {
        const guild = ch.guild;
        const me = guild?.members?.me;
        if (guild && me) {
          const perms = ch.permissionsFor(me);
          if (!perms?.has('SendMessages')) continue;
          if (ch.isThread?.() && !perms?.has('SendMessagesInThreads')) continue;
        }
      } catch {}

      out.push(ch);
      added.add(id);
    }
  } catch (e) {
    console.log('[SWEEP] channel resolve error:', e?.message || e);
  }

  return out;
}

// ================= CORE: TX.TO DETECTION =================
async function analyzeEngineTx(provider, txHash) {
  const tx = await provider.getTransaction(txHash).catch(() => null);
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!tx || !receipt) return null;

  // ✅ Must be a call to Engine contract (this is the important fix)
  const toAddr = (tx.to || '').toLowerCase();
  if (!toAddr || toAddr !== ENGINE_CONTRACT) return null;

  // Parse ERC721 transfers in this tx
  const transfers = [];
  const sellers = new Set();
  const buyers = new Set();
  const tokenIds = [];

  for (const lg of (receipt.logs || [])) {
    // ERC721 Transfer has 4 topics: [sig, from, to, tokenId]
    if (lg.topics?.[0] !== TRANSFER_TOPIC) continue;
    if (!lg.topics || lg.topics.length < 4) continue;

    let parsed;
    try { parsed = ERC721_IFACE.parseLog(lg); } catch { continue; }

    const from = safeAddr(parsed.args.from);
    const to = safeAddr(parsed.args.to);
    const tokenId = parsed.args.tokenId?.toString?.() ?? String(parsed.args.tokenId);

    // Filter out weird/burn events if any
    if (!tokenId) continue;

    transfers.push({
      collection: (lg.address || '').toLowerCase(),
      from,
      to,
      tokenId
    });

    tokenIds.push(tokenId);
    if (from) sellers.add(from);
    if (to) buyers.add(to);
  }

  if (!transfers.length) {
    // Engine call without NFT transfers (not a sweep)
    return null;
  }

  // Sweeper: tx.from is the caller
  const sweeper = safeAddr(tx.from);

  return {
    txHash: txHash.toLowerCase(),
    sweeper,
    tokenIds,
    sellers: [...sellers],
    buyers: [...buyers],
    transfers
  };
}

function pickSellerLabel(sellers) {
  if (!sellers || sellers.length === 0) return 'Unknown';
  if (sellers.length === 1) return shortWalletLink(sellers[0]);
  return `Multiple Sellers (${sellers.length})`;
}

async function sendSweepEmbed(client, sweep, channels) {
  const count = sweep.tokenIds.length;

  const embed = {
    title: `🧹 ENGINE SWEEP – ${count} NFT${count === 1 ? '' : 's'}`,
    description: count === 1
      ? `Token ID: ${formatTokenIds(sweep.tokenIds, 1)}`
      : `Token IDs: ${formatTokenIds(sweep.tokenIds, 25)}`,
    image: { url: SWEEP_IMG },
    fields: [
      { name: '👤 Seller', value: pickSellerLabel(sweep.sellers), inline: true },
      { name: '🧑‍💻 Buyer', value: shortWalletLink(sweep.sweeper), inline: true },
      { name: '💳 Method', value: 'ENGINE', inline: true }
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

async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) {
    if (DEBUG) console.log('[SWEEP] no provider');
    return;
  }

  await ensureCheckpointTable(client);

  const latest = await provider.getBlockNumber().catch(() => null);
  if (!latest) return;

  let last = await getLastBlock(client);

  // ✅ First boot: start near head so we do NOT replay old sweeps
  if (!last || last <= 0) last = Math.max(latest - 2, 0);

  // Determine scan range (and cap it)
  const minFrom = Math.max(latest - LOOKBACK_BLOCKS, 0);
  let fromBlock = Math.max(last + 1, minFrom);
  let toBlock = latest;

  if (toBlock - fromBlock > MAX_BLOCKS_PER_TICK) {
    toBlock = fromBlock + MAX_BLOCKS_PER_TICK;
  }

  if (fromBlock > toBlock) {
    // nothing to do, still advance checkpoint to latest
    await setLastBlock(client, latest);
    return;
  }

  if (DEBUG) console.log(`[SWEEP] scan blocks ${fromBlock} -> ${toBlock}`);

  const channels = await resolveChannels(client);
  if (!channels.length && DEBUG) console.log('[SWEEP] no channels resolved');

  // Scan each block's txs and only analyze txs that call Engine
  let found = 0;
  for (let bn = fromBlock; bn <= toBlock; bn++) {
    const block = await provider.getBlock(bn, true).catch(() => null); // include txs
    const txs = block?.transactions || [];
    if (!txs.length) continue;

    for (const tx of txs) {
      const txTo = (tx?.to || '').toLowerCase();
      if (!txTo || txTo !== ENGINE_CONTRACT) continue;

      const h = (tx?.hash || '').toLowerCase();
      if (!h || isSeen(h)) continue;
      markSeen(h);

      const sweep = await analyzeEngineTx(provider, h).catch(() => null);
      if (!sweep) continue;

      found++;
      if (DEBUG) console.log(`[SWEEP] MATCH tx=${h} nfts=${sweep.tokenIds.length}`);
      if (channels.length) {
        await sendSweepEmbed(client, sweep, channels);
      }
    }
  }

  // ✅ advance checkpoint
  await setLastBlock(client, toBlock);

  if (DEBUG) console.log(`[SWEEP] done. found=${found} checkpoint=${toBlock}`);
}

// ================= START =================
function startEngineSweepNotifierBase(client) {
  if (global._engine_sweep_base) return;
  global._engine_sweep_base = true;

  console.log('🧹 Engine Sweep notifier started (Base)');
  if (DEBUG) {
    console.log(`[SWEEP] engine=${ENGINE_CONTRACT} poll=${POLL_MS}ms lookback=${LOOKBACK_BLOCKS} maxBlocksPerTick=${MAX_BLOCKS_PER_TICK}`);
  }

  if (BOOT_PING) {
    resolveChannels(client).then(chs => {
      for (const ch of chs) {
        ch.send('🧹 Engine Sweep notifier online.').catch(() => {});
      }
    }).catch(() => {});
  }

  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };

