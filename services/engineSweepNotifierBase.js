const { Interface, ethers } = require('ethers');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

/* ======================================================
   CONFIG
====================================================== */
const ENGINE_CONTRACT =
  '0x0351f7cba83277e891d4a85da498a7eacd764d58'.toLowerCase();

const POLL_MS     = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK    = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 80);
const MAX_BLOCKS  = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 25);
const MAX_TXS     = Number(process.env.SWEEP_MAX_TX_PER_TICK || 300);

const DEBUG       = process.env.SWEEP_DEBUG === '1';
const BOOT_PING   = process.env.SWEEP_BOOT_PING === '1';

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
   EVENT TOPICS
====================================================== */
const ERC721_TRANSFER = ethers.id(
  'Transfer(address,address,uint256)'
);

const ERC1155_SINGLE = ethers.id(
  'TransferSingle(address,address,address,uint256,uint256)'
);

const ERC1155_BATCH = ethers.id(
  'TransferBatch(address,address,address,uint256[],uint256[])'
);

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
   TX ANALYSIS (ERC721 + ERC1155, ENGINE CUSTODY)
====================================================== */
async function analyzeTx(provider, hash) {
  const tx = await provider.getTransaction(hash);
  const rc = await provider.getTransactionReceipt(hash);
  if (!tx || !rc) return null;

  const listed = [];
  const bought = [];

  for (const log of rc.logs) {

    // ===== ERC721 =====
    if (log.topics[0] === ERC721_TRANSFER && log.topics.length >= 4) {
      const from = '0x' + log.topics[1].slice(26).toLowerCase();
      const to   = '0x' + log.topics[2].slice(26).toLowerCase();
      const tokenId = BigInt(log.topics[3]).toString();

      if (to === ENGINE_CONTRACT && from !== ethers.ZeroAddress) {
        listed.push({ tokenId, from });
      }

      if (from === ENGINE_CONTRACT) {
        bought.push({ tokenId, to });
      }
    }

    // ===== ERC1155 SINGLE =====
    if (log.topics[0] === ERC1155_SINGLE) {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['address','address','address','uint256','uint256'],
        log.data
      );

      const from = decoded[1].toLowerCase();
      const to   = decoded[2].toLowerCase();
      const tokenId = decoded[3].toString();

      if (to === ENGINE_CONTRACT) {
        listed.push({ tokenId, from });
      }

      if (from === ENGINE_CONTRACT) {
        bought.push({ tokenId, to });
      }
    }

    // ===== ERC1155 BATCH =====
    if (log.topics[0] === ERC1155_BATCH) {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['address','address','address','uint256[]','uint256[]'],
        log.data
      );

      const from = decoded[1].toLowerCase();
      const to   = decoded[2].toLowerCase();
      const tokenIds = decoded[3].map(id => id.toString());

      for (const tokenId of tokenIds) {
        if (to === ENGINE_CONTRACT) {
          listed.push({ tokenId, from });
        }
        if (from === ENGINE_CONTRACT) {
          bought.push({ tokenId, to });
        }
      }
    }
  }

  if (bought.length) {
    return {
      type: bought.length > 1 ? 'SWEEP' : 'BUY',
      tx,
      transfers: bought
    };
  }

  if (listed.length) {
    return {
      type: 'LIST',
      tx,
      transfers: listed
    };
  }

  return null;
}

/* ======================================================
   EMBEDS
====================================================== */
async function sendSweep(client, data, chans) {
  const embed = {
    title: `🧹 ENGINE SWEPT – ${data.transfers.length} NFTs`,
    description: `${emoji(data.transfers.length)}\n${shortList(
      data.transfers.map(t => t.tokenId)
    )}`,
    image: { url: SWEEP_IMG },
    fields: [
      { name: 'Buyer', value: shortWalletLink(data.transfers[0].to), inline: true },
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
    title: '📌 NFT LISTED TO ENGINE',
    description: shortList(data.transfers.map(t => t.tokenId)),
    image: { url: SWEEP_IMG },
    fields: [
      { name: 'Lister', value: shortWalletLink(data.transfers[0].from), inline: true },
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
====================================================== */
async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) return;

  await ensureCheckpoint(client);

  const latest = await provider.getBlockNumber();
  let last = await getLastBlock(client);
  if (!last) last = latest - 5;

  const from = Math.max(last + 1, latest - LOOKBACK);
  const to   = Math.min(latest, from + MAX_BLOCKS);

  DEBUG && console.log(`[SWEEP] blocks ${from} → ${to}`);

  const logs = await provider.getLogs({
    topics: [[ERC721_TRANSFER, ERC1155_SINGLE, ERC1155_BATCH]],
    fromBlock: from,
    toBlock: to
  });

  const txs = [...new Set(logs.map(l => l.transactionHash))].slice(0, MAX_TXS);
  const chans = await resolveChannels(client);

  for (const h of txs) {
    if (seen.has(h)) continue;
    seen.add(h);

    const res = await analyzeTx(provider, h);
    if (!res) continue;

    DEBUG && console.log(`[SWEEP] MATCH ${res.type} ${h}`);

    if (res.type === 'SWEEP' || res.type === 'BUY')
      await sendSweep(client, res, chans);

    if (res.type === 'LIST')
      await sendList(client, res, chans);
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

