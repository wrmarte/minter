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


const SWAP_NOTI_CHANNELS = (process.env.SWAP_NOTI_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const MIN_USD_TO_POST   = Number(process.env.SWAP_MIN_USD || 0);
const POLL_MS           = Number(process.env.SWAP_POLL_MS || 12000);
const LOOKBACK_BLOCKS   = Number(process.env.SWAP_LOOKBACK_BLOCKS || 20);
const MAX_EMOJI_REPEAT  = Number(process.env.SWAP_MAX_EMOJIS || 20);

const BUY_IMG  = process.env.SWAP_BUY_IMG  || 'https://iili.io/3tSecKP.gif';
const SELL_IMG = process.env.SWAP_SELL_IMG || 'https://iili.io/f7SxSte.gif';

const DEBUG = String(process.env.SWAP_DEBUG || '').trim() === '1';
const BOOT_PING = String(process.env.SWAP_BOOT_PING || '').trim() === '1';
const TEST_TX = (process.env.SWAP_TEST_TX || '').trim().toLowerCase();

// ======= HELPERS =======
const ERC20_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

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

let _ethUsdCache = { value: 0, ts: 0 };
async function getEthUsdPriceCached(maxAgeMs = 30_000) {
  const now = Date.now();
  if (_ethUsdCache.value > 0 && (now - _ethUsdCache.ts) < maxAgeMs) return _ethUsdCache.value;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json().catch(() => null);
    const px = Number(data?.ethereum?.usd || 0);
    if (px > 0) {
      _ethUsdCache = { value: px, ts: now };
      return px;
    }
  } catch {}
  return _ethUsdCache.value || 0;
}

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

function safeAddr(x) { try { return ethers.getAddress(x); } catch { return x || ''; } }
function addrEq(a, b) { return (a || '').toLowerCase() === (b || '').toLowerCase(); }

function buildEmojiLine(isBuy, usd) {
  const u = Number(usd);
  if (!Number.isFinite(u) || u <= 0) return isBuy ? '🟥🟦🚀' : '🔻💀🔻';

  // ✅ whale scaling: $10+ => 1 🐳 per $5
  if (isBuy && u >= 10) {
    const whales = Math.max(1, Math.floor(u / 5));
    return '🐳'.repeat(Math.min(whales, MAX_EMOJI_REPEAT));
  }

  const count = Math.max(1, Math.floor(u / 2));
  return (isBuy ? '🟥🟦🚀' : '🔻💀🔻').repeat(Math.min(count, MAX_EMOJI_REPEAT));
}

async function resolveChannels(client) {
  const out = [];
  for (const id of SWAP_NOTI_CHANNELS) {
    let ch = client.channels.cache.get(id) || null;
    if (!ch) ch = await client.channels.fetch(id).catch(() => null);

    if (!ch) {
      if (DEBUG) console.log(`[SWAP] channel fetch failed: ${id}`);
      continue;
    }

    const isText = typeof ch.isTextBased === 'function' ? ch.isTextBased() : false;
    if (!isText) {
      if (DEBUG) console.log(`[SWAP] channel not text-based: ${id}`);
      continue;
    }

    try {
      const guild = ch.guild;
      const me = guild?.members?.me;
      if (guild && me) {
        const perms = ch.permissionsFor(me);
        if (!perms?.has('SendMessages')) {
          if (DEBUG) console.log(`[SWAP] missing SendMessages in ${id}`);
          continue;
        }
        if (ch.isThread?.() && !perms?.has('SendMessagesInThreads')) {
          if (DEBUG) console.log(`[SWAP] missing SendMessagesInThreads in ${id}`);
          continue;
        }
      }
    } catch {}

    out.push(ch);
  }
  return out;
}

// Core: compute net ADRIAN + (ETH native or WETH) for tx.from wallet
async function analyzeSwap(provider, txHash) {
  const tx = await provider.getTransaction(txHash).catch(() => null);
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!tx || !receipt) return null;

  const wallet = safeAddr(tx.from);
  if (!wallet) return null;

  const adrianDec = await getDecimals(provider, ADRIAN);
  const wethDec = await getDecimals(provider, WETH);

  let adrianIn = 0n, adrianOut = 0n;
  let wethIn = 0n, wethOut = 0n;

  for (const lg of receipt.logs) {
    if (lg.topics?.[0] !== TRANSFER_TOPIC || lg.topics.length !== 3) continue;

    const token = (lg.address || '').toLowerCase();
    if (token !== ADRIAN && token !== WETH) continue;

    let parsed;
    try { parsed = ERC20_IFACE.parseLog(lg); } catch { continue; }

    const from = safeAddr(parsed.args.from);
    const to = safeAddr(parsed.args.to);
    const val = parsed.args.value;

    if (token === ADRIAN) {
      if (addrEq(to, wallet)) adrianIn += val;
      if (addrEq(from, wallet)) adrianOut += val;
    } else {
      if (addrEq(to, wallet)) wethIn += val;
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
    if (tx.value && tx.value > 0n) ethNativeSpent = Number(ethers.formatEther(tx.value));
  } catch {}

  const isBuy  = netAdrian > 0 && (ethNativeSpent > 0 || wethOutF > 0);
  const isSell = netAdrian < 0 && (wethInF > 0 || ethNativeSpent > 0);

  if (!isBuy && !isSell) return null;

  const tokenAmount = Math.abs(netAdrian);
  const ethValue = isBuy ? (ethNativeSpent > 0 ? ethNativeSpent : wethOutF)
                         : (wethInF > 0 ? wethInF : ethNativeSpent);

  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) return null;
  if (!Number.isFinite(ethValue) || ethValue <= 0) return null;

  const ethUsd = await getEthUsdPriceCached();
  const usdValue = ethUsd > 0 ? ethValue * ethUsd : 0;

  return { wallet, txHash: txHash.toLowerCase(), isBuy, isSell, ethValue, usdValue, tokenAmount };
}

async function sendSwapEmbed(client, swap) {
  const { wallet, isBuy, ethValue, usdValue, tokenAmount, txHash } = swap;

  if (MIN_USD_TO_POST > 0 && usdValue > 0 && usdValue < MIN_USD_TO_POST) {
    if (DEBUG) console.log(`[SWAP] skip < MIN_USD ${usdValue.toFixed(2)} tx=${txHash}`);
    return;
  }

  const emojiLine = buildEmojiLine(isBuy, usdValue);

  const embed = {
    title: isBuy ? `🅰️ ADRIAN SWAP BUY!` : `🅰️ ADRIAN SWAP SELL!`,
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
        name: isBuy ? '👤 Swapper' : '🖕 Seller',
        value: shortWalletLink ? shortWalletLink(wallet) : wallet,
        inline: true
      }
    ],
    url: `https://basescan.org/tx/${txHash}`,
    color: isBuy ? 0x3498db : 0xff0000,
    footer: { text: 'Third-Party Swap Feed • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  const chans = await resolveChannels(client);
  if (DEBUG) console.log(`[SWAP] send -> channels=${chans.length} tx=${txHash}`);
  for (const ch of chans) {
    await ch.send({ embeds: [embed] }).catch(err => {
      console.log(`[SWAP] send failed channel=${ch.id} err=${err?.message || err}`);
    });
  }
}

async function bootPing(client) {
  const chans = await resolveChannels(client);
  if (DEBUG) console.log(`[SWAP] bootPing channels=${chans.length}`);
  for (const ch of chans) {
    await ch.send(`✅ Swap notifier online (Base).`).catch(err => {
      console.log(`[SWAP] bootPing failed channel=${ch.id} err=${err?.message || err}`);
    });
  }
}

async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) {
    if (DEBUG) console.log('[SWAP] safeRpcCall(base) returned no provider');
    return;
  }

  // Force-test tx path
  if (TEST_TX && !isSeen(TEST_TX)) {
    markSeen(TEST_TX);
    if (DEBUG) console.log(`[SWAP] TEST_TX analyze ${TEST_TX}`);
    const swap = await analyzeSwap(provider, TEST_TX).catch(e => {
      console.log(`[SWAP] TEST_TX analyze error: ${e?.message || e}`);
      return null;
    });
    if (swap) {
      if (DEBUG) console.log(`[SWAP] TEST_TX matched ${swap.isBuy ? 'BUY' : 'SELL'} usd=${swap.usdValue?.toFixed?.(2)} eth=${swap.ethValue?.toFixed?.(4)}`);
      await sendSwapEmbed(client, swap);
    } else {
      console.log('[SWAP] TEST_TX did NOT match swap rules (or tx/receipt unavailable)');
    }
  }

  const blockNumber = await provider.getBlockNumber().catch(() => null);
  if (!blockNumber) return;

  const fromBlock = Math.max(blockNumber - LOOKBACK_BLOCKS, 0);
  const toBlock = blockNumber;

  if (DEBUG) console.log(`[SWAP] scan blocks ${fromBlock} -> ${toBlock}`);

  if (!ROUTERS_TO_WATCH.length) {
    console.log('[SWAP] ROUTERS_TO_WATCH is empty. Paste router addresses to watch.');
    return;
  }

  // Pull tx hashes by scanning router "to" addresses (much lower volume than WETH)
  const txs = new Set();

  for (const router of ROUTERS_TO_WATCH) {
    let logs = [];
    try {
      logs = await provider.getLogs({ address: router, fromBlock, toBlock });
    } catch (e) {
      console.log(`[SWAP] router getLogs failed ${router}: ${e?.message || e}`);
      continue;
    }
    if (DEBUG) console.log(`[SWAP] router ${router} logs=${logs.length}`);
    for (const lg of logs) {
      const h = (lg.transactionHash || '').toLowerCase();
      if (h) txs.add(h);
    }
  }

  let analyzed = 0, matched = 0;
  for (const h of txs) {
    if (isSeen(h)) continue;
    markSeen(h);

    analyzed++;
    const swap = await analyzeSwap(provider, h).catch(() => null);
    if (!swap) continue;

    // must involve ADRIAN net transfer
    matched++;
    if (DEBUG) console.log(`[SWAP] MATCH tx=${h} ${swap.isBuy ? 'BUY' : 'SELL'} usd=${swap.usdValue?.toFixed?.(2)} eth=${swap.ethValue?.toFixed?.(4)} adrian=${swap.tokenAmount?.toFixed?.(2)}`);
    await sendSwapEmbed(client, swap);
  }

  if (DEBUG) console.log(`[SWAP] analyzed=${analyzed} matched=${matched}`);
}

function startThirdPartySwapNotifierBase(client) {
  if (global._third_party_swap_base) return;
  global._third_party_swap_base = true;

  console.log(`✅ Swap notifier starting (Base) | channels=${SWAP_NOTI_CHANNELS.length} | lookback=${LOOKBACK_BLOCKS} | debug=${DEBUG ? 'ON' : 'OFF'} | bootPing=${BOOT_PING ? 'ON' : 'OFF'}`);

  if (!SWAP_NOTI_CHANNELS.length) {
    console.log('⚠️ SWAP_NOTI_CHANNELS is empty. Nothing can be posted.');
  }

  if (BOOT_PING) bootPing(client).catch(() => {});
  tick(client).catch(() => {});

  setInterval(() => {
    tick(client).catch(() => {});
  }, POLL_MS);
}

module.exports = { startThirdPartySwapNotifierBase };

