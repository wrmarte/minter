const { Interface, ethers } = require('ethers');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

// ================= CONFIG =================
const ENGINE_CONTRACT =
  '0x0351f7cba83277e891d4a85da498a7eacd764d58'.toLowerCase();

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

let _checkpointReady = false;
async function ensureCheckpointTable(client) {
  if (_checkpointReady) return true;
  if (!client.pg) return false;

  await client.pg.query(`
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
    const r = await client.pg.query(
      `SELECT value FROM sweep_checkpoints WHERE chain=$1 AND key=$2`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY]
    );
    return r.rows[0]?.value ? Number(r.rows[0].value) : null;
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

// ================= ABI =================
const ERC721_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
]);

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const APPROVAL_TOPIC = ethers.id('Approval(address,address,uint256)');
const APPROVAL_FOR_ALL_TOPIC = ethers.id('ApprovalForAll(address,address,bool)');

// ================= HELPERS =================
function safeAddr(a) {
  try { return ethers.getAddress(a); } catch { return a || ''; }
}

function buildEmoji(n) {
  if (n >= 20) return '🐳🐳🐳🐳';
  if (n >= 10) return '🐳🐳🐳';
  if (n >= 5) return '🐳🐳';
  if (n >= 3) return '🐳';
  return '🧹';
}

function formatTokenIds(ids, max = 25) {
  const out = ids.slice(0, max).map(i => `#${i}`).join(', ');
  return ids.length > max ? `${out} … +${ids.length - max}` : out;
}

// ================= DEDUPE =================
const seenTx = new Set();

// ================= CHANNELS =================
async function resolveChannels(client) {
  const out = [];
  const rows = await client.pg.query(`
    SELECT DISTINCT channel_id
    FROM tracked_tokens
    WHERE channel_id IS NOT NULL AND channel_id <> ''
  `);

  for (const r of rows.rows) {
    const ch = await client.channels.fetch(r.channel_id).catch(() => null);
    if (ch?.isTextBased()) out.push(ch);
  }
  return out;
}

// ================= ANALYSIS =================
async function analyzeReceipt(provider, txHash) {
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!receipt) return null;

  const tokenIds = [];
  const sellers = new Set();
  let approvals = 0;

  for (const lg of receipt.logs) {
    const t0 = lg.topics?.[0];

    // ---- SWEEP ----
    if (t0 === TRANSFER_TOPIC && lg.topics.length >= 4) {
      const parsed = ERC721_IFACE.parseLog(lg);
      if (parsed.args.from !== ethers.ZeroAddress) {
        tokenIds.push(parsed.args.tokenId.toString());
        sellers.add(parsed.args.from);
      }
      continue;
    }

    // ---- LISTING ----
    if (t0 === APPROVAL_TOPIC) {
      const approved = safeAddr(`0x${lg.topics[2].slice(26)}`);
      if (approved.toLowerCase() === ENGINE_CONTRACT) approvals++;
    }

    if (t0 === APPROVAL_FOR_ALL_TOPIC) {
      const operator = safeAddr(`0x${lg.topics[2].slice(26)}`);
      const approved = lg.data.endsWith('1');
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
async function sendSweep(client, data, channels) {
  const embed = {
    title: `🧹 ENGINE SWEPT – ${data.tokenIds.length} NFTs`,
    description: `${buildEmoji(data.tokenIds.length)}\n${formatTokenIds(data.tokenIds)}`,
    image: { url: SWEEP_IMG },
    fields: [
      { name: 'Seller(s)', value: data.sellers.length > 1 ? 'Multiple' : shortWalletLink(data.sellers[0]), inline: true },
      { name: 'Method', value: 'ENGINE', inline: true }
    ],
    url: `https://basescan.org/tx/${data.txHash}`,
    color: 0xf1c40f,
    footer: { text: 'Engine Feed • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const ch of channels) await ch.send({ embeds: [embed] }).catch(() => {});
}

async function sendListing(client, data, channels) {
  const embed = {
    title: '📌 NFT LISTED TO ENGINE',
    description: `Approval granted to Engine`,
    image: { url: SWEEP_IMG },
    fields: [
      { name: 'Approvals', value: String(data.approvals), inline: true },
      { name: 'Method', value: 'ENGINE', inline: true }
    ],
    url: `https://basescan.org/tx/${data.txHash}`,
    color: 0x2ecc71,
    footer: { text: 'Engine Feed • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const ch of channels) await ch.send({ embeds: [embed] }).catch(() => {});
}

// ================= SCANNER =================
async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) return;

  await ensureCheckpointTable(client);

  const latest = await provider.getBlockNumber();
  let last = await getLastBlock(client);
  if (!last) last = latest - 2;

  let from = Math.max(last + 1, latest - LOOKBACK_BLOCKS);
  let to = Math.min(from + MAX_BLOCKS_PER_TICK, latest);

  if (DEBUG) console.log(`[SWEEP] blocks ${from} → ${to}`);

  const channels = await resolveChannels(client);

  for (let bn = from; bn <= to; bn++) {
    const block = await provider.getBlock(bn, true).catch(() => null);
    if (!block?.transactions) continue;

    for (const tx of block.transactions.slice(0, MAX_TX_PER_BLOCK)) {
      if (!tx?.hash || seenTx.has(tx.hash)) continue;
      seenTx.add(tx.hash);

      const res = await analyzeReceipt(provider, tx.hash);
      if (!res) continue;

      if (DEBUG) console.log(`[SWEEP] MATCH ${res.type} tx=${tx.hash}`);

      if (res.type === 'SWEEP') await sendSweep(client, res, channels);
      if (res.type === 'LISTING') await sendListing(client, res, channels);
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
    resolveChannels(client).then(chs =>
      chs.forEach(ch => ch.send('🧹 Engine Sweep notifier online').catch(() => {}))
    );
  }

  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };


