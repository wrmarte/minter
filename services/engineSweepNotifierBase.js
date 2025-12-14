const { Interface, ethers } = require('ethers');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

// ================= CONFIG =================
const ENGINE_CONTRACT =
  '0x0351f7cba83277e891d4a85da498a7eacd764d58'.toLowerCase();

const POLL_MS = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK_BLOCKS = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 40);
const MAX_BLOCKS_PER_TICK = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 12);
const MAX_TX_PER_BLOCK = Number(process.env.SWEEP_MAX_TX_PER_BLOCK || 250);

const DEBUG = String(process.env.SWEEP_DEBUG || '').trim() === '1';
const BOOT_PING = String(process.env.SWEEP_BOOT_PING || '').trim() === '1';

const SWEEP_IMG =
  process.env.SWEEP_IMG || 'https://iili.io/3tSecKP.gif';

// ================= CHECKPOINT =================
const CHECKPOINT_CHAIN = 'base';
const CHECKPOINT_KEY = 'engine_sweep_last_block';

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
  try {
    await client.pg.query(
      `INSERT INTO sweep_checkpoints(chain, key, value)
       VALUES ($1,$2,$3)
       ON CONFLICT (chain,key)
       DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY, Math.floor(block)]
    );
  } catch {}
}

// ================= ABI / TOPICS =================
const ERC721_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)'
]);

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const APPROVAL_TOPIC = ethers.id('Approval(address,address,uint256)');
const APPROVAL_FOR_ALL_TOPIC = ethers.id('ApprovalForAll(address,address,bool)');

// ================= HELPERS =================
function safeAddr(x) {
  try { return ethers.getAddress(x); } catch { return x || ''; }
}

function buildEmoji(count) {
  if (count >= 20) return '🐳🐳🐳🐳';
  if (count >= 10) return '🐳🐳🐳';
  if (count >= 5)  return '🐳🐳';
  if (count >= 3)  return '🐳';
  return '🧹';
}

function formatTokenIds(tokenIds, max = 25) {
  const list = tokenIds.slice(0, max).map(id => `#${id}`).join(', ');
  if (tokenIds.length > max) return `${list} … +${tokenIds.length - max} more`;
  return list || 'N/A';
}

// ================= DEDUPE =================
const seenTx = new Map();
function markSeen(txh) {
  const now = Date.now();
  seenTx.set(txh, now);
  if (seenTx.size > 8000) {
    const cutoff = now - 6 * 60 * 60 * 1000;
    for (const [k, ts] of seenTx.entries()) {
      if (ts < cutoff) seenTx.delete(k);
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

  const res = await client.pg.query(`
    SELECT DISTINCT channel_id
    FROM tracked_tokens
    WHERE channel_id IS NOT NULL
      AND channel_id <> ''
  `);

  for (const r of res.rows) {
    const id = String(r.channel_id || '').trim();
    if (!id || added.has(id)) continue;

    let ch = client.channels.cache.get(id)
      || await client.channels.fetch(id).catch(() => null);

    if (!ch || !ch.isTextBased()) continue;
    out.push(ch);
    added.add(id);
  }

  return out;
}

// ================= CORE ANALYSIS =================
async function analyzeEngineTx(provider, txHash) {
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!receipt) return null;

  const tokenIds = [];
  const sellers = new Set();
  let approvals = 0;

  for (const lg of receipt.logs || []) {
    const t0 = lg.topics?.[0];

    // --------- SWEEP (Transfers) ----------
    if (t0 === TRANSFER_TOPIC && lg.topics.length >= 4) {
      let parsed;
      try { parsed = ERC721_IFACE.parseLog(lg); } catch { continue; }

      if (parsed.args.from === ethers.ZeroAddress) continue;

      tokenIds.push(parsed.args.tokenId.toString());
      sellers.add(parsed.args.from);
      continue;
    }

    // --------- LISTING (Approvals) ----------
    if (t0 === APPROVAL_TOPIC && lg.topics.length >= 4) {
      const approved = safeAddr(`0x${lg.topics[2].slice(26)}`);
      if (approved.toLowerCase() === ENGINE_CONTRACT) approvals++;
    }

    if (t0 === APPROVAL_FOR_ALL_TOPIC && lg.topics.length >= 3) {
      const operator = safeAddr(`0x${lg.topics[2].slice(26)}`);
      const approved = lg.data === ethers.AbiCoder.defaultAbiCoder()
        .encode(['bool'], [true]);

      if (approved && operator.toLowerCase() === ENGINE_CONTRACT) approvals++;
    }
  }

  if (tokenIds.length >= 2) {
    return { type: 'SWEEP', txHash, tokenIds, sellers: [...sellers] };
  }

  if (approvals > 0) {
    return { type: 'LISTING', txHash, approvals };
  }

  return null;
}

// ================= EMBEDS =================
async function sendSweepEmbed(client, data, channels) {
  const count = data.tokenIds.length;

  const embed = {
    title: `🧹 ENGINE SWEPT – ${count} NFT${count === 1 ? '' : 's'}`,
    description: `${buildEmoji(count)}\nTokens: ${formatTokenIds(data.tokenIds)}`,
    image: { url: SWEEP_IMG },
    fields: [
      { name: '👤 Seller(s)', value: data.sellers.length > 1 ? 'Multiple' : shortWalletLink(data.sellers[0]), inline: true },
      { name: '💳 Method', value: 'ENGINE', inline: true }
    ],
    url: `https://basescan.org/tx/${data.txHash}`,
    color: 0xf1c40f,
    footer: { text: 'Engine Feed • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const ch of channels) {
    await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

async function sendListingEmbed(client, data, channels) {
  const embed = {
    title: '📌 NFT LISTED TO ENGINE',
    description: `NFT approval granted to Engine.`,
    image: { url: SWEEP_IMG },
    fields: [
      { name: '✅ Approvals', value: String(data.approvals), inline: true },
      { name: '💳 Method', value: 'ENGINE', inline: true }
    ],
    url: `https://basescan.org/tx/${data.txHash}`,
    color: 0x2ecc71,
    footer: { text: 'Engine Feed • Powered by PimpsDev' },
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
  if (!last) last = latest - 2;

  const from = Math.max(last + 1, latest - LOOKBACK_BLOCKS);
  let to = latest;

  if (to - from > MAX_BLOCKS_PER_TICK) {
    to = from + MAX_BLOCKS_PER_TICK;
  }

  const channels = await resolveChannels(client);

  for (let bn = from; bn <= to; bn++) {
    const block = await provider.getBlock(bn, true).catch(() => null);
    if (!block?.transactions) continue;

    for (const tx of block.transactions.slice(0, MAX_TX_PER_BLOCK)) {
      if (!tx.to || tx.to.toLowerCase() !== ENGINE_CONTRACT) continue;

      const h = tx.hash.toLowerCase();
      if (isSeen(h)) continue;
      markSeen(h);

      const result = await analyzeEngineTx(provider, h);
      if (!result) continue;

      if (result.type === 'SWEEP') {
        await sendSweepEmbed(client, result, channels);
      } else if (result.type === 'LISTING') {
        await sendListingEmbed(client, result, channels);
      }
    }
  }

  await setLastBlock(client, to);
}

// ================= START =================
function startEngineSweepNotifierBase(client) {
  if (global._engine_sweep_base) return;
  global._engine_sweep_base = true;

  console.log('🧹 Engine notifier started (Base)');

  if (BOOT_PING) {
    resolveChannels(client).then(chs => {
      for (const ch of chs) ch.send('🧹 Engine notifier online.').catch(() => {});
    });
  }

  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };


