const { Interface, ethers } = require('ethers');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

/* ======================================================
   CONFIG
====================================================== */
const ENGINE_CONTRACT =
  '0x0351f7cba83277e891d4a85da498a7eacd764d58'.toLowerCase();

const ENGINE_TOPIC = '0x000000000000000000000000' + ENGINE_CONTRACT.slice(2);

const POLL_MS    = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK   = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 80);
const MAX_BLOCKS = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 25);
const MAX_TXS    = Number(process.env.SWEEP_MAX_TX_PER_TICK || 300);

const DEBUG     = process.env.SWEEP_DEBUG === '1';
const BOOT_PING = process.env.SWEEP_BOOT_PING === '1';

// one-time reset via env (recommended): set SWEEP_FORCE_RESET=1 for one deploy, then remove
const FORCE_RESET_SWEEP = process.env.SWEEP_FORCE_RESET === '1';

const TEST_TX = (process.env.SWEEP_TEST_TX || '').trim().toLowerCase();

const SWEEP_IMG =
  process.env.SWEEP_IMG || 'https://iili.io/3tSecKP.gif';

/* ======================================================
   CHECKPOINT
====================================================== */
const CHECKPOINT_CHAIN = 'base';
const CHECKPOINT_KEY   = 'engine_sweep_last_block';

async function ensureCheckpoint(client) {
  await client.pg.query(`
    CREATE TABLE IF NOT EXISTS sweep_checkpoints (
      chain TEXT NOT NULL,
      key   TEXT NOT NULL,
      value BIGINT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (chain, key)
    )
  `);
}

async function getLastBlock(client) {
  const r = await client.pg.query(
    `SELECT value FROM sweep_checkpoints WHERE chain=$1 AND key=$2`,
    [CHECKPOINT_CHAIN, CHECKPOINT_KEY]
  );
  return r.rows?.[0]?.value ? Number(r.rows[0].value) : null;
}

async function setLastBlock(client, block) {
  await client.pg.query(
    `INSERT INTO sweep_checkpoints(chain,key,value)
     VALUES ($1,$2,$3)
     ON CONFLICT (chain,key)
     DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [CHECKPOINT_CHAIN, CHECKPOINT_KEY, Math.floor(block)]
  );
}

/* ======================================================
   TOPICS / ABIs
====================================================== */
const ERC721_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)'
]);

const ERC1155_IFACE = new Interface([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
]);

const ERC721_TRANSFER = ethers.id('Transfer(address,address,uint256)');
const ERC721_APPROVAL = ethers.id('Approval(address,address,uint256)');
const ERC721_APPROVAL_ALL = ethers.id('ApprovalForAll(address,address,bool)');

const ERC1155_SINGLE = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
const ERC1155_BATCH  = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');

/* ======================================================
   HELPERS
====================================================== */
const seen = new Set();

function emoji(n) {
  if (n >= 20) return '🐳🐳🐳🐳';
  if (n >= 10) return '🐳🐳🐳';
  if (n >= 5)  return '🐳🐳';
  if (n >= 3)  return '🐳';
  return '🧹';
}

function shortList(ids, max = 25) {
  const out = ids.slice(0, max).map(id => `#${id}`).join(', ');
  return ids.length > max ? `${out} … +${ids.length - max}` : out;
}

function pickMostCommon(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [k, n] of m.entries()) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

/* ======================================================
   CHANNEL ROUTING
====================================================== */
async function resolveChannels(client) {
  const out = [];
  const r = await client.pg.query(`
    SELECT DISTINCT channel_id
    FROM tracked_tokens
    WHERE channel_id IS NOT NULL AND channel_id <> ''
  `);

  for (const row of r.rows) {
    const ch =
      client.channels.cache.get(row.channel_id) ||
      await client.channels.fetch(row.channel_id).catch(() => null);
    if (ch?.isTextBased()) out.push(ch);
  }
  return out;
}

/* ======================================================
   CORE ANALYSIS
   Strategy:
   - LIST: detect approvals granted to Engine (Approval / ApprovalForAll)
   - BUY/SWEEP: detect tx.to == ENGINE, then parse ALL NFT transfers in receipt
====================================================== */
async function analyzeTx(provider, hash) {
  const tx = await provider.getTransaction(hash);
  const rc = await provider.getTransactionReceipt(hash);
  if (!tx || !rc) return null;

  const toEngine = (tx.to || '').toLowerCase() === ENGINE_CONTRACT;

  const approvals = [];
  const transfers = []; // {standard, tokenId, from, to, nft, qty?}

  for (const log of rc.logs) {
    const topic0 = log.topics?.[0];

    // ---------- ERC721 Transfer ----------
    if (topic0 === ERC721_TRANSFER && log.topics.length >= 4) {
      // emitted by NFT contract
      const from = ('0x' + log.topics[1].slice(26)).toLowerCase();
      const to   = ('0x' + log.topics[2].slice(26)).toLowerCase();
      const tokenId = BigInt(log.topics[3]).toString();

      transfers.push({
        standard: 'ERC721',
        nft: log.address.toLowerCase(),
        tokenId,
        from,
        to
      });
      continue;
    }

    // ---------- ERC1155 Single ----------
    if (topic0 === ERC1155_SINGLE) {
      // topics: [sig, operator, from, to] ; data: id,value
      const from = ('0x' + log.topics[2].slice(26)).toLowerCase();
      const to   = ('0x' + log.topics[3].slice(26)).toLowerCase();
      let decoded;
      try { decoded = ERC1155_IFACE.parseLog(log); } catch { decoded = null; }
      const tokenId = decoded?.args?.id?.toString?.() || '0';
      const qty = decoded?.args?.value?.toString?.() || '1';

      transfers.push({
        standard: 'ERC1155',
        nft: log.address.toLowerCase(),
        tokenId,
        qty,
        from,
        to
      });
      continue;
    }

    // ---------- ERC1155 Batch ----------
    if (topic0 === ERC1155_BATCH) {
      const from = ('0x' + log.topics[2].slice(26)).toLowerCase();
      const to   = ('0x' + log.topics[3].slice(26)).toLowerCase();
      let decoded;
      try { decoded = ERC1155_IFACE.parseLog(log); } catch { decoded = null; }

      const ids = decoded?.args?.ids || [];
      const values = decoded?.args?.values || [];

      for (let i = 0; i < ids.length; i++) {
        transfers.push({
          standard: 'ERC1155',
          nft: log.address.toLowerCase(),
          tokenId: ids[i].toString(),
          qty: (values[i] ? values[i].toString() : '1'),
          from,
          to
        });
      }
      continue;
    }

    // ---------- Approvals (LIST signal) ----------
    if (topic0 === ERC721_APPROVAL) {
      // topics: [sig, owner, approved, tokenId]
      const approved = ('0x' + log.topics[2].slice(26)).toLowerCase();
      if (approved === ENGINE_CONTRACT) approvals.push({ kind: 'Approval', nft: log.address.toLowerCase() });
      continue;
    }

    if (topic0 === ERC721_APPROVAL_ALL) {
      // topics: [sig, owner, operator] ; data: bool
      const operator = ('0x' + log.topics[2].slice(26)).toLowerCase();
      if (operator === ENGINE_CONTRACT) {
        // decode bool (approved)
        const approved = ethers.AbiCoder.defaultAbiCoder().decode(['bool'], log.data)?.[0];
        if (approved) approvals.push({ kind: 'ApprovalForAll', nft: log.address.toLowerCase() });
      }
      continue;
    }
  }

  // ---------- BUY/SWEEP ----------
  // If tx is calling engine and we saw NFT transfers in receipt, treat as buy/sweep.
  // Filter out mint/burn and obvious non-transfer noise.
  if (toEngine && transfers.length) {
    const nftMoves = transfers.filter(t =>
      t.from !== ethers.ZeroAddress &&
      t.to !== ethers.ZeroAddress
    );

    if (nftMoves.length) {
      // buyer is most common recipient across transfers
      const buyer = pickMostCommon(nftMoves.map(t => t.to));
      const seller = pickMostCommon(nftMoves.map(t => t.from));

      const tokenIds = nftMoves.map(t => t.tokenId);

      return {
        type: nftMoves.length > 1 ? 'SWEEP' : 'BUY',
        tx,
        buyer,
        seller,
        transfers: nftMoves,
        tokenIds
      };
    }
  }

  // ---------- LIST ----------
  // Many engines/listings never transfer NFT at list time; approvals are the “listed” signal.
  if (approvals.length) {
    return {
      type: 'LIST',
      tx,
      approvals
    };
  }

  // ---------- Debug support ----------
  if (DEBUG && TEST_TX && hash === TEST_TX) {
    console.log('[SWEEP][DEBUG] TEST_TX analyzed. toEngine=', toEngine, 'transfers=', transfers.length, 'approvals=', approvals.length);
    for (const t of transfers.slice(0, 15)) console.log('[SWEEP][DEBUG] transfer', t);
  }

  return null;
}

/* ======================================================
   EMBEDS
====================================================== */
async function sendSweep(client, data, chans) {
  const embed = {
    title: `🧹 ENGINE ${data.type === 'SWEEP' ? 'SWEPT' : 'BOUGHT'} – ${data.transfers.length} NFTs`,
    description: `${emoji(data.transfers.length)}\n${shortList(
      data.tokenIds
    )}`,
    image: { url: SWEEP_IMG },
    fields: [
      { name: 'Buyer', value: shortWalletLink(data.buyer || data.tx.from), inline: true },
      { name: 'Seller', value: shortWalletLink(data.seller || '0x0000'), inline: true },
      { name: 'Method', value: 'ENGINE', inline: true }
    ],
    url: `https://basescan.org/tx/${data.tx.hash}`,
    color: 0xf1c40f,
    footer: { text: 'Engine Feed • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const c of chans) await c.send({ embeds: [embed] }).catch(() => {});
}

async function sendList(client, data, chans) {
  const embed = {
    title: '📌 NFT LIST ACTION (ENGINE)',
    description: `Approval granted to Engine (${data.approvals?.[0]?.kind || 'Approval'})`,
    image: { url: SWEEP_IMG },
    fields: [
      { name: 'Lister', value: shortWalletLink(data.tx.from), inline: true },
      { name: 'Method', value: 'ENGINE', inline: true }
    ],
    url: `https://basescan.org/tx/${data.tx.hash}`,
    color: 0x2ecc71,
    footer: { text: 'Engine Feed • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const c of chans) await c.send({ embeds: [embed] }).catch(() => {});
}

/* ======================================================
   MAIN LOOP
   We fetch Engine contract logs (cheap) to get tx hashes that interacted with Engine.
   Then analyze each tx receipt for NFT transfers & approvals.
====================================================== */
async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) return;

  await ensureCheckpoint(client);

  const latest = await provider.getBlockNumber();

  // one-time force reset per process (prevents spam)
  if (FORCE_RESET_SWEEP && !global.__engineSweepResetDone) {
    const last = latest - 25; // scan a bit wider on reset
    await setLastBlock(client, last);
    global.__engineSweepResetDone = true;
    console.log('🧹 [SWEEP] checkpoint force-reset (one-time)');
  }

  let last = await getLastBlock(client);
  if (!last) last = latest - 5;

  const from = Math.max(last + 1, latest - LOOKBACK);
  const to   = Math.min(latest, from + MAX_BLOCKS);

  DEBUG && console.log(`[SWEEP] blocks ${from} → ${to}`);

  // Pull only Engine contract logs (small & reliable)
  const engineLogs = await provider.getLogs({
    address: ENGINE_CONTRACT,
    fromBlock: from,
    toBlock: to
  });

  const txs = [...new Set(engineLogs.map(l => l.transactionHash))].slice(0, MAX_TXS);
  const chans = await resolveChannels(client);

  for (const h of txs) {
    if (seen.has(h)) continue;
    seen.add(h);

    // If user set a TEST_TX, always analyze it (even if not in this tick's range)
    if (TEST_TX && h !== TEST_TX) {
      // still analyze normal ones; no change
    }

    const res = await analyzeTx(provider, h);
    if (!res) continue;

    DEBUG && console.log(`[SWEEP] MATCH ${res.type} ${h}`);

    if (res.type === 'LIST') await sendList(client, res, chans);
    if (res.type === 'BUY' || res.type === 'SWEEP') await sendSweep(client, res, chans);
  }

  // If user provided TEST_TX, analyze it once even if it wasn't in engineLogs (useful debugging)
  if (TEST_TX && !seen.has(TEST_TX)) {
    seen.add(TEST_TX);
    const res = await analyzeTx(provider, TEST_TX);
    if (res) {
      DEBUG && console.log(`[SWEEP] MATCH ${res.type} ${TEST_TX}`);
      if (res.type === 'LIST') await sendList(client, res, chans);
      if (res.type === 'BUY' || res.type === 'SWEEP') await sendSweep(client, res, chans);
    } else {
      DEBUG && console.log(`[SWEEP] TEST_TX no match ${TEST_TX}`);
    }
  }

  await setLastBlock(client, to);
}

/* ======================================================
   START
====================================================== */
function startEngineSweepNotifierBase(client) {
  if (global.__engineSweepStarted) return;
  global.__engineSweepStarted = true;

  console.log('🧹 Engine Sweep notifier started');

  if (BOOT_PING) {
    resolveChannels(client).then(chs => {
      for (const ch of chs)
        ch.send('🧹 Engine Sweep notifier online').catch(() => {});
    });
  }

  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };
