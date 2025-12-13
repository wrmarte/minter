// services/thirdPartySwapNotifierBase.js
const { Interface, Contract, ethers } = require('ethers');
const fetch = require('node-fetch');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

/**
 * Third Party Swap Notifier (Base)
 * Router-safe detection for swaps between ETH/WETH <-> ADRIAN:
 *   - BUY: wallet receives ADRIAN AND spends ETH/WETH in same tx
 *   - SELL: wallet sends ADRIAN AND receives WETH in same tx
 *
 * Uses same embed vibe you’ve been running:
 *  - Spent/Received: USD + ETH
 *  - Got/Sold: ADRIAN
 *  - Wallet field (+ 🖕 on sell)
 *  - Emoji bar w/ whales (>= $10 => 🐳 per $5)
 */

// --- CONFIG ---
const ADRIAN = '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'.toLowerCase();
const WETH   = '0x4200000000000000000000000000000000000006'.toLowerCase(); // Base WETH

// Where to post
const SWAP_NOTI_CHANNELS = (process.env.SWAP_NOTI_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Optional filters / tuning
const MIN_USD_TO_POST   = Number(process.env.SWAP_MIN_USD || 0);     // set to 0 to post all
const POLL_MS           = Number(process.env.SWAP_POLL_MS || 8000);
const LOOKBACK_BLOCKS   = Number(process.env.SWAP_LOOKBACK_BLOCKS || 5);
const MAX_EMOJI_REPEAT  = Number(process.env.SWAP_MAX_EMOJIS || 20);

// Images
const BUY_IMG  = process.env.SWAP_BUY_IMG  || 'https://iili.io/3tSecKP.gif';
const SELL_IMG = process.env.SWAP_SELL_IMG || 'https://iili.io/f7SxSte.gif';

// --- Topics / iface ---
const ERC20_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

// Dedupe
const seenTx = new Set();

// --- ETH/USD cache ---
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

// --- decimals cache ---
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

function normalizeChannels(chs) {
  if (!chs || !Array.isArray(chs)) return [];
  return chs.map(String).filter(Boolean);
}

function buildEmojiLine(isBuy, usd) {
  const u = Number(usd);
  if (!Number.isFinite(u) || u <= 0) return isBuy ? '🟥🟦🚀' : '🔻💀🔻';

  // Whale mode for buys >= $10 => 🐳 per $5
  if (isBuy && u >= 10) {
    const whales = Math.max(1, Math.floor(u / 5));
    return '🐳'.repeat(Math.min(whales, MAX_EMOJI_REPEAT));
  }

  // Normal scale: per $2
  const count = Math.max(1, Math.floor(u / 2));
  return (isBuy ? '🟥🟦🚀' : '🔻💀🔻').repeat(Math.min(count, MAX_EMOJI_REPEAT));
}

/**
 * Router-safe swap inference from receipt:
 * BUY detection (common aggregator pattern):
 *   - find ADRIAN Transfer(s) where to == tx.from (wallet receives ADRIAN)
 *   - compute ETH spent from tx.value OR WETH outflow from wallet
 *
 * SELL detection (router-safe-ish):
 *   - find ADRIAN Transfer(s) where from == tx.from (wallet sends ADRIAN)
 *   - compute WETH received by wallet in logs (to == wallet)
 *
 * NOTE: Native ETH RECEIVED on sell is often internal and not visible in logs;
 * we prioritize WETH receives for sells (works for most routers).
 */
async function analyzeSwap(provider, txHash) {
  const tx = await provider.getTransaction(txHash).catch(() => null);
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!tx || !receipt) return null;

  const wallet = safeAddr(tx.from);
  if (!wallet) return null;

  const adrianDec = await getDecimals(provider, ADRIAN);
  const wethDec = await getDecimals(provider, WETH);

  let adrianIn = 0n;
  let adrianOut = 0n;

  let wethIn = 0n;
  let wethOut = 0n;

  // Sum token flows for the wallet only (router-safe)
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
    } else if (token === WETH) {
      if (addrEq(to, wallet)) wethIn += val;
      if (addrEq(from, wallet)) wethOut += val;
    }
  }

  const adrianInF  = Number(ethers.formatUnits(adrianIn, adrianDec));
  const adrianOutF = Number(ethers.formatUnits(adrianOut, adrianDec));
  const wethInF    = Number(ethers.formatUnits(wethIn, wethDec));
  const wethOutF   = Number(ethers.formatUnits(wethOut, wethDec));

  const netAdrian = adrianInF - adrianOutF;

  // Native ETH spent (buy case)
  let ethNativeSpent = 0;
  try {
    if (tx.value && tx.value > 0n) ethNativeSpent = Number(ethers.formatEther(tx.value));
  } catch {}

  // BUY: wallet receives ADRIAN (netAdrian > 0) and spends ETH/WETH
  // spent ETH = tx.value if present else WETH outflow
  const isBuy = netAdrian > 0 && (ethNativeSpent > 0 || wethOutF > 0);

  // SELL: wallet sends ADRIAN (netAdrian < 0) and receives WETH
  const isSell = netAdrian < 0 && wethInF > 0;

  if (!isBuy && !isSell) return null;

  const tokenAmount = Math.abs(netAdrian);

  let ethValue = 0;
  if (isBuy) {
    ethValue = ethNativeSpent > 0 ? ethNativeSpent : wethOutF;
  } else {
    // sell: value received (in ETH terms) approximated by WETH received
    ethValue = wethInF;
  }

  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) return null;
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

async function sendSwapEmbed(client, swap) {
  const { wallet, isBuy, ethValue, usdValue, tokenAmount, txHash } = swap;

  if (MIN_USD_TO_POST > 0 && usdValue > 0 && usdValue < MIN_USD_TO_POST) return;

  const emojiLine = buildEmojiLine(isBuy, usdValue);
  const title = isBuy ? `🅰️ ADRIAN SWAP BUY!` : `🅰️ ADRIAN SWAP SELL!`;

  const embed = {
    title,
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

  const channels = normalizeChannels(SWAP_NOTI_CHANNELS);
  for (const id of channels) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch?.isTextBased?.()) {
      await ch.send({ embeds: [embed] }).catch(() => {});
    }
  }
}

function startThirdPartySwapNotifierBase(client) {
  if (global._third_party_swap_base) return;
  global._third_party_swap_base = true;

  if (!SWAP_NOTI_CHANNELS.length) {
    console.log('⚠️ SWAP_NOTI_CHANNELS not set. Swap notifier running but nowhere to post.');
  }

  setInterval(async () => {
    const provider = await safeRpcCall('base', p => p);
    if (!provider) return;

    const blockNumber = await provider.getBlockNumber().catch(() => null);
    if (!blockNumber) return;

    const fromBlock = Math.max(blockNumber - LOOKBACK_BLOCKS, 0);
    const toBlock = blockNumber;

    // Watch ADRIAN transfers (cheap) and analyze by tx hash
    let logs = [];
    try {
      logs = await provider.getLogs({
        address: ADRIAN,
        topics: [TRANSFER_TOPIC],
        fromBlock,
        toBlock
      });
    } catch {
      return;
    }

    const txs = [];
    for (const lg of logs) {
      const h = (lg.transactionHash || '').toLowerCase();
      if (!h) continue;
      if (seenTx.has(h)) continue;
      seenTx.add(h);
      txs.push(h);
    }

    for (const h of txs) {
      const swap = await analyzeSwap(provider, h);
      if (!swap) continue;
      await sendSwapEmbed(client, swap);
    }
  }, POLL_MS);

  console.log('✅ Third-party swap notifier (Base, router-safe) started.');
}

module.exports = {
  startThirdPartySwapNotifierBase
};
