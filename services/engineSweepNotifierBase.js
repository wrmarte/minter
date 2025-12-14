const { Interface, ethers } = require('ethers');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

// ================= CONFIG =================
const ENGINE_CONTRACT =
  '0x0351f7cba83277e891d4a85da498a7eacd764d58'.toLowerCase();

// Optional extra routers/proxies you may discover later (comma-separated).
// If empty, we only watch ENGINE_CONTRACT.
const EXTRA_ROUTERS = (process.env.SWEEP_ROUTERS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const ROUTERS_TO_WATCH = Array.from(
  new Set([ENGINE_CONTRACT, ...EXTRA_ROUTERS].map(a => (a || '').toLowerCase()))
).filter(Boolean);

const POLL_MS = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK_BLOCKS = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 40);
const MAX_BLOCKS_PER_TICK = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 12); // safety cap
const MAX_TX_PER_BLOCK = Number(process.env.SWEEP_MAX_TX_PER_BLOCK || 250); // safety cap

const DEBUG = String(process.env.SWEEP_DEBUG || '').trim() === '1';
const BOOT_PING = String(process.env.SWEEP_BOOT_PING || '').trim() === '1';

const SWEEP_IMG = process.env.SWEEP_IMG || 'https://iili.io/3tSecKP.gif';

// ================= CHECKPOINT =================
const CHECKPOINT_CHAIN = 'base';
const CHECKPOINT_KEY = 'engine_sweep_last_block';

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
    const pg = client.pg;
    if (!pg) return null;

    const res = await pg.query(
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
    const pg = client.pg;
    if (!pg) return;

    const v = Math.floor(Number(block));
    if (!Number.isFinite(v) || v <= 0) return;

    await pg.query(
      `INSERT INTO sweep_checkpoints(chain, key, value)
       VALUES ($1,$2,$3)
       ON CONFLICT (chain,key)
       DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY, v]
    );
  } catch {}
}

// ================= HELPERS =================
const ERC721_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
]);

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const APPROVAL_TOPIC = ethers.id('Approval(address,address,uint256)');
const APPROVAL_FOR_ALL_TOPIC = ethers.id('ApprovalForAll(address,address,bool)');

function safeAddr(x) {
  try { return ethers.getAddress(x); } catch { return x || ''; }
}

function addrEq(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
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

// In-memory dedupe (prevents double-posts within a run)
const seenTx = new Map();
function markSeen(txh) {
  const now = Date.now();
  seenTx.set(txh, now);
  if (seenTx.size > 8000) {
    const cutoff = now - 6 * 60 * 60 * 1000;
    for (const [k, ts] of seenTx.entries()) if (ts < cutoff) seenTx.delete(k);
  }
}
function isSeen(txh) { return seenTx.has(txh); }

// ================= CHANNEL ROUTING =================
// Uses same DB the mint/token tracker uses.
// Sends to any channel that has tracked_tokens.channel_id (you can tighten later).
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

      const isText = typeof ch?.isTextBased === 'function' ? ch.isTextBased() : !!ch;
      if (!ch || !isText) continue;

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

// ================= CORE ANALYSIS =================
// Option A reality: Engine doesn't emit transfers; collections do.
// So: if tx.to is router/engine, we parse *all* receipt logs for ERC721 transfers + approvals.
async function analyzeEngineLikeTx(provider, txHash) {
  const tx = await provider.getTransaction(txHash).catch(() => null);
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!tx || !receipt) return null;

  const toAddr = (tx.to || '').toLowerCase();
  if (!toAddr || !ROUTERS_TO_WATCH.includes(toAddr)) return null;

  const caller = safeAddr(tx.from);

  // Collect ERC721 transfers (sweep)
  const transfers = [];
  const tokenIds = [];
  const sellers = new Set();
  const buyers = new Set();
  const collections = new Set();

  // Collect approvals (listing)
  let approvalsToEngine = 0;
  const approvedCollections = new Set();

  for (const lg of (receipt.logs || [])) {
    const t0 = lg.topics?.[0];

    // ---- Transfers ----
    if (t0 === TRANSFER_TOPIC && lg.topics?.length >= 4) {
      let parsed;
      try { parsed = ERC721_IFACE.parseLog(lg); } catch { parsed = null; }
      if (!parsed) continue;

      const from = safeAddr(parsed.args.from);
      const to = safeAddr(parsed.args.to);
      const tokenId = parsed.args.tokenId?.toString?.() ?? String(parsed.args.tokenId);

      // Ignore mint/burn noise if it ever appears
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
      if (lg.address) collections.add((lg.address || '').toLowerCase());
      continue;
    }

    // ---- Listing signals (Approvals to Engine) ----
    // Approval(owner, approved, tokenId)
    if (t0 === APPROVAL_TOPIC && lg.topics?.length >= 4) {
      let parsed;
      try { parsed = ERC721_IFACE.parseLog(lg); } catch { parsed = null; }
      if (!parsed) continue;

      const approved = safeAddr(parsed.args.approved);
      if (addrEq(approved, ENGINE_CONTRACT)) {
        approvalsToEngine++;
        if (lg.address) approvedCollections.add((lg.address || '').toLowerCase());
      }
      continue;
    }

    // ApprovalForAll(owner, operator, approved)
    if (t0 === APPROVAL_FOR_ALL_TOPIC && lg.topics?.length >= 3) {
      let parsed;
      try { parsed = ERC721_IFACE.parseLog(lg); } catch { parsed = null; }
      if (!parsed) continue;

      const operator = safeAddr(parsed.args.operator);
      const approved = Boolean(parsed.args.approved);

      if (approved && addrEq(operator, ENGINE_CONTRACT)) {
        approvalsToEngine++;
        if (lg.address) approvedCollections.add((lg.address || '').toLowerCase());
      }
      continue;
    }
  }

  const isSweep = transfers.length > 0;
  const isListing = !isSweep && approvalsToEngine > 0;

  if (!isSweep && !isListing) return null;

  return {
    txHash: txHash.toLowerCase(),
    routerTo: safeAddr(tx.to),
    caller,
    isSweep,
    isListing,
    tokenIds,
    transfers,
    sellers: [...sellers],
    buyers: [...buyers],
    collections: [...collections],
    approvalsToEngine,
    approvedCollections: [...approvedCollections]
  };
}

function pickSellerLabel(sellers) {
  if (!sellers || sellers.length === 0) return 'Unknown';
  if (sellers.length === 1) return shortWalletLink(sellers[0]);
  return `Multiple Sellers (${sellers.length})`;
}

async function sendEmbed(client, data, channels) {
  if (!channels.length) {
    if (DEBUG) console.log('[SWEEP] No channels resolved -> skip send');
    return;
  }

  const nowIso = new Date().toISOString();

  if (data.isSweep) {
    const count = data.tokenIds.length;

    const embed = {
      title: `🧹 ENGINE SWEPT – ${count} NFT${count === 1 ? '' : 's'}`,
      description: `${buildEmoji(count)}\n${count === 1
        ? `Token: ${formatTokenIds(data.tokenIds, 1)}`
        : `Tokens: ${formatTokenIds(data.tokenIds, 25)}`
      }`,
      image: { url: SWEEP_IMG },
      fields: [
        { name: '👤 Seller', value: pickSellerLabel(data.sellers), inline: true },
        { name: '🧑‍💻 Buyer', value: shortWalletLink(data.caller), inline: true },
        { name: '💳 Method', value: 'ENGINE', inline: true },
      ],
      url: `https://basescan.org/tx/${data.txHash}`,
      color: 0xf1c40f,
      footer: { text: 'Engine Feed • Powered by PimpsDev' },
      timestamp: nowIso
    };

    for (const ch of channels) await ch.send({ embeds: [embed] }).catch(() => {});
    return;
  }

  // Listing embed (Approval / ApprovalForAll to Engine)
  if (data.isListing) {
    const embed = {
      title: `📌 LISTED TO ENGINE`,
      description: `A wallet granted Engine approval (listing-ready).\n\n✅ Approvals: **${data.approvalsToEngine}**`,
      image: { url: SWEEP_IMG },
      fields: [
        { name: '👤 Lister', value: shortWalletLink(data.caller), inline: true },
        { name: '🧩 Contract(s)', value: data.approvedCollections?.length ? `**${data.approvedCollections.length}**` : 'N/A', inline: true },
        { name: '💳 Method', value: 'ENGINE', inline: true },
      ],
      url: `https://basescan.org/tx/${data.txHash}`,
      color: 0x2ecc71,
      footer: { text: 'Engine Feed • Powered by PimpsDev' },
      timestamp: nowIso
    };

    for (const ch of channels) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

// ================= BLOCK SCANNER =================
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

  // First boot: start near head to avoid replay spam
  if (!last || last <= 0) last = Math.max(latest - 2, 0);

  // Determine scan range + cap it
  const minFrom = Math.max(latest - LOOKBACK_BLOCKS, 0);
  let fromBlock = Math.max(last + 1, minFrom);
  let toBlock = latest;

  if (toBlock - fromBlock > MAX_BLOCKS_PER_TICK) {
    toBlock = fromBlock + MAX_BLOCKS_PER_TICK;
  }

  if (fromBlock > toBlock) {
    await setLastBlock(client, latest);
    return;
  }

  if (DEBUG) console.log(`[SWEEP] scan blocks ${fromBlock} -> ${toBlock}`);

  const channels = await resolveChannels(client);

  let matched = 0;
  let checked = 0;

  for (let bn = fromBlock; bn <= toBlock; bn++) {
    // Try fast path: get block w/ tx objects
    let block = await provider.getBlock(bn, true).catch(() => null);
    if (!block) continue;

    let txs = block.transactions || [];
    if (!Array.isArray(txs) || txs.length === 0) continue;

    // ethers sometimes returns hashes instead of full tx objects depending on RPC
    // Normalize to array of tx objects with .hash and .to
    const normalized = [];

    for (const t of txs.slice(0, MAX_TX_PER_BLOCK)) {
      if (typeof t === 'string') {
        // hash only -> fetch tx
        const txObj = await provider.getTransaction(t).catch(() => null);
        if (txObj) normalized.push(txObj);
      } else {
        normalized.push(t);
      }
    }

    for (const tx of normalized) {
      const txTo = (tx?.to || '').toLowerCase();
      if (!txTo || !ROUTERS_TO_WATCH.includes(txTo)) continue;

      const h = (tx?.hash || '').toLowerCase();
      if (!h || isSeen(h)) continue;
      markSeen(h);

      checked++;

      const data = await analyzeEngineLikeTx(provider, h).catch(() => null);
      if (!data) continue;

      matched++;
      if (DEBUG) {
        console.log(`[SWEEP] MATCH tx=${h} type=${data.isSweep ? 'SWEEP' : 'LIST'} transfers=${data.tokenIds?.length || 0} approvals=${data.approvalsToEngine || 0}`);
      }

      await sendEmbed(client, data, channels);
    }
  }

  await setLastBlock(client, toBlock);

  if (DEBUG) console.log(`[SWEEP] tick done. checked=${checked} matched=${matched} checkpoint=${toBlock}`);
}

// ================= START =================
function startEngineSweepNotifierBase(client) {
  if (global._engine_sweep_base) return;
  global._engine_sweep_base = true;

  console.log(`🧹 Engine notifier started (Base) | routers=${ROUTERS_TO_WATCH.length} | poll=${POLL_MS}ms | lookback=${LOOKBACK_BLOCKS} | maxBlocks=${MAX_BLOCKS_PER_TICK}`);

  if (DEBUG) {
    console.log(`[SWEEP] watch routers: ${ROUTERS_TO_WATCH.join(', ')}`);
  }

  if (BOOT_PING) {
    resolveChannels(client).then(chs => {
      for (const ch of chs) ch.send('🧹 Engine notifier online.').catch(() => {});
    }).catch(() => {});
  }

  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };


