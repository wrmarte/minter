// globalProcessor.js — enhanced (kept logic), safer fetches, decimals-aware amounts, light caching, better channel fallback
const { Interface, formatUnits, ethers } = require('ethers');
const fetch = require('node-fetch');
const { fetchLogs } = require('./logScanner');
const { getProvider } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

/** Known router addresses across chains (lowercased at runtime) */
const ROUTERS = [
  '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', // Base: Uniswap v3?
  '0x420dd381b31aef6683e2c581f93b119eee7e3f4d', // ApeChain: Magic Eden router
  '0xfbeef911dc5821886e1dda23b3e4f3eaffdd7930',
  '0x812e79c9c37eD676fdbdd1212D6a4e47EFfC6a42',
  '0xa5e0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  '0x95ebfcb1c6b345fda69cf56c51e30421e5a35aec'
];

const TAX_OR_BURN = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
  '0xdead000000000000000042069420694206942069'
];

const seenTx = new Set();

/* ===================== tiny caches ===================== */
const _decimalsCache = new Map();          // tokenAddr -> decimals
const _isContractCache = new Map();        // addr -> boolean
const _ethPriceCache = { ts: 0, value: 0 }; // 30s TTL
const _gtPriceCache = new Map();           // tokenAddr -> { ts, price }
const _gtTokenCache = new Map();           // tokenAddr -> { ts, mcap }

/* ===================== helpers ===================== */
const ROUTERS_LOWER = ROUTERS.map(r => r.toLowerCase());
const TAX_OR_BURN_LOWER = TAX_OR_BURN.map(a => a.toLowerCase());

function nowSec() { return Math.floor(Date.now() / 1000); }

async function fetchJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(t);
  }
}

async function getDecimals(tokenAddress) {
  const key = (tokenAddress || '').toLowerCase();
  if (_decimalsCache.has(key)) return _decimalsCache.get(key);
  try {
    const abi = ['function decimals() view returns (uint8)'];
    const erc20 = new ethers.Contract(key, abi, getProvider());
    const d = await erc20.decimals();
    _decimalsCache.set(key, Number(d) || 18);
  } catch {
    _decimalsCache.set(key, 18);
  }
  return _decimalsCache.get(key);
}

async function isContractAddress(address) {
  const key = (address || '').toLowerCase();
  if (_isContractCache.has(key)) return _isContractCache.get(key);
  try {
    const code = await getProvider().getCode(key);
    const val = code && code !== '0x';
    _isContractCache.set(key, val);
    return val;
  } catch {
    _isContractCache.set(key, false);
    return false;
  }
}

/* ===================== public entry ===================== */
module.exports = async function processUnifiedBlock(client, fromBlock, toBlock) {
  const pg = client.pg;
  const tokenRes = await pg.query('SELECT * FROM tracked_tokens');
  const tokenRows = tokenRes.rows;

  const addresses = [...new Set(tokenRows.map(row => (row.address || '').toLowerCase()))];
  if (addresses.length === 0) {
    console.log('✅ No tokens to scan.');
    return;
  }

  let logs;
  try {
    logs = await fetchLogs(addresses, fromBlock, toBlock);
  } catch (err) {
    console.warn(`⚠️ fetchLogs failed: ${err.message}`);
    return;
  }

  for (const log of logs) {
    await handleTokenLog(client, tokenRows, log);
  }
};

/* ===================== core log handler ===================== */
async function handleTokenLog(client, tokenRows, log) {
  const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint amount)']);
  let parsed;
  try {
    parsed = iface.parseLog(log);
  } catch { return; }

  const { from, to, amount } = parsed.args;
  const fromAddr = (from || '').toLowerCase();
  const toAddr = (to || '').toLowerCase();
  const tokenAddress = (log.address || '').toLowerCase();

  if (seenTx.has(log.transactionHash)) return;
  seenTx.add(log.transactionHash);

  // ❌ Skip router-to-router or known tax/burn flows
  if (ROUTERS_LOWER.includes(fromAddr) && ROUTERS_LOWER.includes(toAddr)) return;
  if (TAX_OR_BURN_LOWER.includes(toAddr) || TAX_OR_BURN_LOWER.includes(fromAddr)) return;

  // ✅ Detect type
  const isBuy = ROUTERS_LOWER.includes(fromAddr) && !ROUTERS_LOWER.includes(toAddr);
  const isSell = !ROUTERS_LOWER.includes(fromAddr) && ROUTERS_LOWER.includes(toAddr);
  if (!isBuy && !isSell) return;

  // ⛔ Skip contract sell sources (likely router/contract accounting)
  if (isSell) {
    try {
      if (await isContractAddress(fromAddr)) {
        // console.log(`⛔ Skipping contract sell from ${fromAddr}`);
        return;
      }
    } catch {}
  }

  // 💰 Value tracking (tx.value only) — best-effort; token amount in embed is from Transfer event
  let usdSpent = 0, ethSpent = 0;
  try {
    const tx = await getProvider().getTransaction(log.transactionHash);
    const ethPrice = await getETHPrice();
    if (tx?.value) {
      ethSpent = Number(formatUnits(tx.value, 18));
      usdSpent = ethSpent * ethPrice;
    }
  } catch {}

  // Amount using dynamic token decimals (fallback 18)
  let tokenAmountRaw = 0;
  try {
    const decimals = await getDecimals(tokenAddress);
    tokenAmountRaw = Number(formatUnits(amount, decimals));
  } catch { tokenAmountRaw = Number(formatUnits(amount, 18)); }

  // ❌ Skip tiny tax reroutes (no value + tiny size)
  if (usdSpent === 0 && ethSpent === 0 && tokenAmountRaw < 5) return;

  // ⛔ LP removal filter: treat zero-value "buys" with pre-existing balance as LP moves
  if (isBuy && usdSpent === 0 && ethSpent === 0) {
    try {
      const abi = ['function balanceOf(address account) view returns (uint256)'];
      const contract = new ethers.Contract(tokenAddress, abi, getProvider());
      const prevBalanceBN = await contract.balanceOf(toAddr, { blockTag: log.blockNumber - 1 });
      const decimals = await getDecimals(tokenAddress);
      const prevBalance = Number(formatUnits(prevBalanceBN, decimals));
      if (prevBalance > 0) {
        // console.log(`⛔ Skipping LP removal pretending to be a buy [${toAddr}]`);
        return;
      }
    } catch (err) {
      console.warn(`⚠️ LP filter failed: ${err.message}`);
    }
  }

  const tokenAmountFormatted = tokenAmountRaw.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  // 🧠 Buy label (new/accumulate indicator)
  let buyLabel = isBuy ? '🆕 New Buy' : '💥 Sell';
  try {
    if (isBuy) {
      const abi = ['function balanceOf(address account) view returns (uint256)'];
      const contract = new ethers.Contract(tokenAddress, abi, getProvider());
      const prevBalanceBN = await contract.balanceOf(toAddr, { blockTag: log.blockNumber - 1 });
      const decimals = await getDecimals(tokenAddress);
      const prevBalance = Number(formatUnits(prevBalanceBN, decimals));
      if (prevBalance > 0) {
        const percentChange = prevBalance > 0 ? ((tokenAmountRaw / prevBalance) * 100).toFixed(1) : '0.0';
        buyLabel = `🔁 +${percentChange}%`;
      }
    }
  } catch {}

  const tokenPrice = await getTokenPriceUSD(tokenAddress);
  const marketCap = await getMarketCapUSD(tokenAddress);

  const repeatFactor = Math.max(1, Math.floor(tokenAmountRaw / 100));
  const emojiLine = isBuy ? '🟥🟦🚀'.repeat(repeatFactor) : '🔻💀🔻'.repeat(repeatFactor);
  const getColorByUsd = (usd) => isBuy
    ? (usd < 10 ? 0xff0000 : usd < 20 ? 0x3498db : 0x00cc66)
    : (usd < 10 ? 0x999999 : usd < 50 ? 0xff6600 : 0xff0000);

  // Send per tracked token row (multi-guild support)
  for (const token of tokenRows.filter(row => (row.address || '').toLowerCase() === tokenAddress)) {
    const guild = client.guilds.cache.get(token.guild_id);
    if (!guild) continue;

    let channel = token.channel_id ? guild.channels.cache.get(token.channel_id) : null;
    if (!channel || !channel.isTextBased() || !channel.permissionsFor(guild.members.me)?.has('SendMessages')) {
      // find any text channel we can speak in
      channel = guild.channels.cache.find(c => c.isTextBased && c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages'));
    }
    if (!channel) continue;

    const usdLine = isFinite(usdSpent) ? usdSpent.toFixed(4) : '0.0000';
    const ethLine = isFinite(ethSpent) ? ethSpent.toFixed(4) : '0.0000';
    const priceLine = isFinite(tokenPrice) ? `$${tokenPrice.toFixed(8)}` : 'N/A';
    const mcapLine = marketCap ? `$${Number(marketCap).toLocaleString()}` : 'Fetching...';

    const embed = {
      title: `${(token.name || 'TOKEN').toUpperCase()} ${isBuy ? 'Buy' : 'Sell'}!`,
      description: emojiLine,
      image: { url: isBuy ? 'https://iili.io/3tSecKP.gif' : 'https://iili.io/3tSeiEF.gif' },
      fields: [
        {
          name: isBuy ? '💸 Spent' : '💰 Value',
          value: `$${usdLine} / ${ethLine} ETH`,
          inline: true
        },
        {
          name: isBuy ? '🎯 Got' : '📤 Sold',
          value: `${tokenAmountFormatted} ${(token.name || 'TOKEN').toUpperCase()}`,
          inline: true
        },
        ...(isBuy
          ? [{
              name: buyLabel.startsWith('🆕') ? '🆕 New Buyer' : '🔁 Accumulated',
              value: buyLabel.replace(/^(🆕|🔁) /, ''),
              inline: true
            }]
          : []),
        { name: '💵 Price', value: priceLine, inline: true },
        { name: '📊 MCap', value: mcapLine, inline: true }
      ],
      url: `https://www.geckoterminal.com/base/pools/${tokenAddress}`, // keeping your existing link format
      color: getColorByUsd(usdSpent),
      footer: { text: 'Live on Base • Powered by PimpsDev' },
      timestamp: new Date().toISOString()
    };

    await channel.send({ embeds: [embed] }).catch(err => {
      console.warn(`❌ Failed to send embed: ${err.message}`);
    });
  }
}

/* ===================== price helpers (cached) ===================== */
async function getETHPrice() {
  const ttl = 30; // seconds
  if (_ethPriceCache.ts && nowSec() - _ethPriceCache.ts < ttl) return _ethPriceCache.value;
  try {
    const data = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', 6000);
    const val = parseFloat(data?.ethereum?.usd || '0') || 0;
    _ethPriceCache.ts = nowSec();
    _ethPriceCache.value = val;
    return val;
  } catch {
    return _ethPriceCache.value || 0;
  }
}

async function getTokenPriceUSD(address) {
  const key = (address || '').toLowerCase();
  const ttl = 20; // seconds
  const cached = _gtPriceCache.get(key);
  if (cached && nowSec() - cached.ts < ttl) return cached.price;

  try {
    const data = await fetchJson(`https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${key}`, 7000);
    const prices = data?.data?.attributes?.token_prices || {};
    const price = parseFloat(prices[key] || '0') || 0;
    _gtPriceCache.set(key, { ts: nowSec(), price });
    return price;
  } catch {
    return cached?.price || 0;
  }
}

async function getMarketCapUSD(address) {
  const key = (address || '').toLowerCase();
  const ttl = 30; // seconds
  const cached = _gtTokenCache.get(key);
  if (cached && nowSec() - cached.ts < ttl) return cached.mcap;

  try {
    const data = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${key}`, 7000);
    const mcap = parseFloat(
      data?.data?.attributes?.fdv_usd ||
      data?.data?.attributes?.market_cap_usd ||
      '0'
    ) || 0;
    _gtTokenCache.set(key, { ts: nowSec(), mcap });
    return mcap;
  } catch {
    return cached?.mcap || 0;
  }
}

