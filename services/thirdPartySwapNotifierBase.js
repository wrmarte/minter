const { Interface, Contract, ethers } = require('ethers');
const fetch = require('node-fetch');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

// ======= CONFIG =======
const ADRIAN = '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'.toLowerCase();
const WETH   = '0x4200000000000000000000000000000000000006'.toLowerCase();

// ✅ PUT YOUR ROUTERS HERE (lowercase)
const ROUTERS_TO_WATCH = [
  '0x498581ff718922c3f8e6a244956af099b2652b2b'
].map(a => (a || '').toLowerCase()).filter(Boolean);

// ✅ ENV fallback channels (only used if DB returns 0)
const SWAP_NOTI_CHANNELS = (process.env.SWAP_NOTI_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const MIN_USD_TO_POST   = Number(process.env.SWAP_MIN_USD || 0);
const POLL_MS           = Number(process.env.SWAP_POLL_MS || 12000);
const LOOKBACK_BLOCKS   = Number(process.env.SWAP_LOOKBACK_BLOCKS || 20);
const MAX_EMOJI_REPEAT  = Number(process.env.SWAP_MAX_EMOJIS || 20);

const BUY_IMG  = process.env.SWAP_BUY_IMG  || 'https://iili.io/f7ifqmB.gif';
const SELL_IMG = process.env.SWAP_SELL_IMG || 'https://iili.io/f7SxSte.gif';

const DEBUG = String(process.env.SWAP_DEBUG || '').trim() === '1';
const BOOT_PING = String(process.env.SWAP_BOOT_PING || '').trim() === '1';
const TEST_TX = (process.env.SWAP_TEST_TX || '').trim().toLowerCase();

// ======= TAG SYSTEM =======
const BUY_TAG_ROLE_NAME  = 'WAGMI';
const SELL_TAG_ROLE_NAME = 'NGMI';

// ======= CHECKPOINT (DB) =======
const CHECKPOINT_CHAIN = 'base';
const CHECKPOINT_KEY   = 'third_party_swaps_last_block';

let _checkpointReady = false;
async function ensureCheckpointTable(client) {
  if (_checkpointReady) return true;
  const pg = client.pg;
  if (!pg) return false;
  try {
    await pg.query(`
      CREATE TABLE IF NOT EXISTS swap_checkpoints (
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
    console.log(`[SWAP] ensureCheckpointTable failed: ${e?.message || e}`);
    return false;
  }
}

async function getLastBlockFromDb(client) {
  const pg = client.pg;
  if (!pg) return null;
  try {
    const res = await pg.query(
      `SELECT value FROM swap_checkpoints WHERE chain=$1 AND key=$2`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY]
    );
    const v = res?.rows?.[0]?.value;
    return (v !== undefined && v !== null) ? Number(v) : null;
  } catch {
    return null;
  }
}

async function setLastBlockInDb(client, blockNum) {
  const pg = client.pg;
  if (!pg) return;
  const v = Number(blockNum);
  if (!Number.isFinite(v) || v <= 0) return;
  try {
    await pg.query(
      `INSERT INTO swap_checkpoints(chain, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (chain, key)
       DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY, Math.floor(v)]
    );
  } catch {}
}

// ======= HELPERS =======
const ERC20_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)'
]);
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const seenTx = new Map();
function markSeen(txh) {
  const now = Date.now();
  seenTx.set(txh, now);
  if (seenTx.size > 5000) {
    const cutoff = now - 6 * 60 * 60 * 1000;
    for (const [k, ts] of seenTx.entries()) {
      if (ts < cutoff) seenTx.delete(k);
    }
  }
}
function isSeen(txh) { return seenTx.has(txh); }

// ======= ETH USD CACHE =======
let _ethUsdCache = { value: 0, ts: 0 };
async function getEthUsdPriceCached(maxAgeMs = 30_000) {
  const now = Date.now();
  if (_ethUsdCache.value > 0 && (now - _ethUsdCache.ts) < maxAgeMs) {
    return _ethUsdCache.value;
  }
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
    );
    const data = await res.json().catch(() => null);
    const px = Number(data?.ethereum?.usd || 0);
    if (px > 0) {
      _ethUsdCache = { value: px, ts: now };
      return px;
    }
  } catch {}
  return _ethUsdCache.value || 0;
}

// ======= DECIMALS =======
const decimalsCache = new Map();
async function getDecimals(provider, tokenAddr) {
  const key = tokenAddr.toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  try {
    const c = new Contract(tokenAddr, ['function decimals() view returns (uint8)'], provider);
    const d = Number(await c.decimals());
    decimalsCache.set(key, d);
    return d;
  } catch {
    decimalsCache.set(key, 18);
    return 18;
  }
}

function safeAddr(x) {
  try { return ethers.getAddress(x); } catch { return x || ''; }
}
function addrEq(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
}

function buildEmojiLine(isBuy, usd) {
  const u = Number(usd);
  if (!Number.isFinite(u) || u <= 0) return isBuy ? '🟥🟦🚀' : '🔻💀🔻';
  if (isBuy && u >= 30) {
    const whales = Math.max(1, Math.floor(u / 2));
    return '🐳🚀'.repeat(Math.min(whales, MAX_EMOJI_REPEAT));
  }
  const count = Math.max(1, Math.floor(u / 2));
  return (isBuy ? '🟥🟦🚀' : '🔻💀🔻').repeat(Math.min(count, MAX_EMOJI_REPEAT));
}

// ======= TAG HELPERS =======
function resolveRoleTag(channel, roleName) {
  try {
    const guild = channel.guild;
    if (!guild) return null;
    const role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) return null;
    return { mention: `<@&${role.id}>`, roleId: role.id };
  } catch {
    return null;
  }
}

// ======= MARKET CAP HELPERS =======
const totalSupplyCache = new Map();

async function getTotalSupplyCached(provider, tokenAddr, maxAgeMs = 10 * 60 * 1000) {
  const key = tokenAddr.toLowerCase();
  const now = Date.now();
  const hit = totalSupplyCache.get(key);
  if (hit && (now - hit.ts) < maxAgeMs) return hit.value;

  try {
    const erc20 = new Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], provider);
    const raw = await erc20.totalSupply();
    const dec = await getDecimals(provider, tokenAddr);
    const supply = Number(ethers.formatUnits(raw, dec));
    if (supply > 0) {
      totalSupplyCache.set(key, { value: supply, ts: now });
      return supply;
    }
  } catch {}
  return hit?.value || 0;
}

function formatCompactUsd(v) {
  if (!v || !isFinite(v)) return 'N/A';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}
// ================= ANALYZE SWAP =================
async function analyzeSwap(provider, txHash) {
  const tx = await provider.getTransaction(txHash).catch(() => null);
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!tx || !receipt) return null;

  const wallet = safeAddr(tx.from);
  if (!wallet) return null;

  const adrianDec = await getDecimals(provider, ADRIAN);
  const wethDec   = await getDecimals(provider, WETH);

  let adrianIn = 0n, adrianOut = 0n;
  let wethIn = 0n, wethOut = 0n;

  for (const lg of receipt.logs) {
    if (lg.topics?.[0] !== TRANSFER_TOPIC || lg.topics.length !== 3) continue;

    const token = (lg.address || '').toLowerCase();
    if (token !== ADRIAN && token !== WETH) continue;

    let parsed;
    try { parsed = ERC20_IFACE.parseLog(lg); } catch { continue; }

    const from = safeAddr(parsed.args.from);
    const to   = safeAddr(parsed.args.to);
    const val  = parsed.args.value;

    if (token === ADRIAN) {
      if (addrEq(to, wallet))   adrianIn  += val;
      if (addrEq(from, wallet)) adrianOut += val;
    } else {
      if (addrEq(to, wallet))   wethIn  += val;
      if (addrEq(from, wallet)) wethOut += val;
    }
  }

  const adrianInF  = Number(ethers.formatUnits(adrianIn, adrianDec));
  const adrianOutF = Number(ethers.formatUnits(adrianOut, adrianDec));
  const wethInF    = Number(ethers.formatUnits(wethIn, wethDec));
  const wethOutF   = Number(ethers.formatUnits(wethOut, wethDec));

  const netAdrian = adrianInF - adrianOutF;

  let ethNativeSpent = 0;
  try {
    if (tx.value && tx.value > 0n) {
      ethNativeSpent = Number(ethers.formatEther(tx.value));
    }
  } catch {}

  const isBuy  = netAdrian > 0 && (ethNativeSpent > 0 || wethOutF > 0);
  const isSellOriginal = netAdrian < 0 && (wethInF > 0 || ethNativeSpent > 0);
  let isSell = isSellOriginal;

  const tokenAmount = Math.abs(netAdrian);
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) return null;

  let ethValue = isBuy
    ? (ethNativeSpent > 0 ? ethNativeSpent : wethOutF)
    : (wethInF > 0 ? wethInF : ethNativeSpent);

  // Native ETH sell fallback
  if (!isBuy && !isSellOriginal) {
    if (!(netAdrian < 0)) return null;
    try {
      const bn = receipt.blockNumber;
      const [balBefore, balAfter] = await Promise.all([
        provider.getBalance(wallet, bn - 1).catch(() => 0n),
        provider.getBalance(wallet, bn).catch(() => 0n)
      ]);

      const gasCost = (receipt.gasUsed || 0n) * (receipt.effectiveGasPrice || 0n);
      const delta = balAfter - balBefore;
      const received = delta + gasCost + (tx.value || 0n);

      const receivedEth = Number(ethers.formatEther(received > 0n ? received : 0n));
      if (receivedEth > 0) {
        ethValue = receivedEth;
        isSell = true;
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }

  if (!isBuy && !isSell) return null;
  if (!Number.isFinite(ethValue) || ethValue <= 0) return null;

  const ethUsd = await getEthUsdPriceCached();
  const usdValue = ethUsd > 0 ? ethValue * ethUsd : 0;

  return {
    wallet,
    txHash: txHash.toLowerCase(),
    isBuy,
    isSell,
    ethValue,
    usdValue,
    tokenAmount
  };
}

// ================= SEND EMBED =================
async function sendSwapEmbed(client, swap, provider) {
  const { wallet, isBuy, ethValue, usdValue, tokenAmount, txHash } = swap;

  if (MIN_USD_TO_POST > 0 && usdValue > 0 && usdValue < MIN_USD_TO_POST) return;

  const emojiLine = buildEmojiLine(isBuy, usdValue);

  let marketCapText = 'N/A';
  try {
    const priceUsd = usdValue / tokenAmount;
    const supply = await getTotalSupplyCached(provider, ADRIAN);
    if (priceUsd > 0 && supply > 0) {
      marketCapText = formatCompactUsd(priceUsd * supply);
    }
  } catch {}

  const embed = {
    title: isBuy ? '🅰️ ADRIAN SWAP BUY!' : '🅰️ ADRIAN SWAP SELL!',
    description: emojiLine,
    image: { url: isBuy ? BUY_IMG : SELL_IMG },
    fields: [
      {
        name: isBuy ? '💸 Spent' : '💰 Received',
        value: `$${usdValue ? usdValue.toFixed(2) : 'N/A'} / ${ethValue.toFixed(4)} ETH`,
        inline: true
      },
      {
        name: isBuy ? '🎯 Got' : '📤 Sold',
        value: `${tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ADRIAN`,
        inline: true
      },
      {
        name: '📊 Market Cap',
        value: marketCapText,
        inline: true
      },
      {
        name: isBuy ? '👤 Swapper' : '🖕 Seller',
        value: shortWalletLink(wallet),
        inline: true
      }
    ],
    url: `https://basescan.org/tx/${txHash}`,
    color: isBuy ? 0x3498db : 0xff0000,
    footer: { text: 'AdrianSWAP • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  const chans = await resolveChannels(client);
  for (const ch of chans) {
    const tag = isBuy
      ? resolveRoleTag(ch, BUY_TAG_ROLE_NAME)
      : resolveRoleTag(ch, SELL_TAG_ROLE_NAME);

    const payload = tag
      ? { content: tag.mention, embeds: [embed], allowedMentions: { roles: [tag.roleId] } }
      : { embeds: [embed] };

    await ch.send(payload).catch(() => {});
  }
}

// ================= BOOT PING =================
async function bootPing(client) {
  const chans = await resolveChannels(client);
  for (const ch of chans) {
    await ch.send('✅ Swap notifier online (Base).').catch(() => {});
  }
}

// ================= MAIN LOOP =================
async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) return;

  await ensureCheckpointTable(client);

  if (TEST_TX && !isSeen(TEST_TX)) {
    markSeen(TEST_TX);
    const swap = await analyzeSwap(provider, TEST_TX);
    if (swap) await sendSwapEmbed(client, swap, provider);
  }

  const blockNumber = await provider.getBlockNumber().catch(() => null);
  if (!blockNumber) return;

  let last = await getLastBlockFromDb(client);
  if (!last || last <= 0) last = Math.max(blockNumber - 2, 0);

  const minFrom = Math.max(blockNumber - LOOKBACK_BLOCKS, 0);
  const fromBlock = Math.max(Math.min(last, blockNumber), minFrom);
  const toBlock = blockNumber;

  const txs = new Set();

  for (const router of ROUTERS_TO_WATCH) {
    try {
      const logs = await provider.getLogs({ address: router, fromBlock, toBlock });
      for (const lg of logs) {
        if (lg.transactionHash) txs.add(lg.transactionHash.toLowerCase());
      }
    } catch {}
  }

  for (const h of txs) {
    if (isSeen(h)) continue;
    markSeen(h);
    const swap = await analyzeSwap(provider, h);
    if (swap) await sendSwapEmbed(client, swap, provider);
  }

  await setLastBlockInDb(client, toBlock);
}

// ================= START =================
function startThirdPartySwapNotifierBase(client) {
  if (global._third_party_swap_base) return;
  global._third_party_swap_base = true;

  console.log(
    `✅ Swap notifier starting (Base) | envChannels=${SWAP_NOTI_CHANNELS.length} | lookback=${LOOKBACK_BLOCKS}`
  );

  if (BOOT_PING) bootPing(client).catch(() => {});
  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startThirdPartySwapNotifierBase };




