const { Interface, formatUnits, ethers } = require('ethers');
const fetch = require('node-fetch');
const { fetchLogs } = require('./logScanner');
const { getProvider } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

const ROUTERS = [
  '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
  '0x420dd381b31aef6683e2c581f93b119eee7e3f4d',
  '0xfbeef911dc5821886e1dda23b3e4f3eaffdd7930',
  '0x812e79c9c37eD676fdbdd1212D6a4e47EFfC6a42',
  '0xa5e0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  '0x95ebfcb1c6b345fda69cf56c51e30421e5a35aec'
];

const seenTx = new Set();

module.exports = async function processUnifiedBlock(client, fromBlock, toBlock) {
  const pg = client.pg;
  const tokenRes = await pg.query('SELECT * FROM tracked_tokens');
  const tokenRows = tokenRes.rows;

  const addresses = [...new Set(tokenRows.map(row => row.address.toLowerCase()))];
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
    await handleTokenBuyLog(client, tokenRows, log);
    await handleTokenSellLog(client, tokenRows, log);
  }
};

// ✅ BUY HANDLER
async function handleTokenSellLog(client, tokenRows, log) {
  const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint amount)']);
  let parsed;
  try {
    parsed = iface.parseLog(log);
  } catch {
    console.log('❌ Failed to parse log');
    return;
  }

  const { from, to, amount } = parsed.args;
  const fromAddr = from.toLowerCase();
  const toAddr = to.toLowerCase();
  const tokenAddress = log.address.toLowerCase();

  if (seenTx.has(log.transactionHash)) return;
  seenTx.add(log.transactionHash);

  const ROUTERS_LOWER = ROUTERS.map(r => r.toLowerCase());
  const taxLikeAddresses = [
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dEaD',
    '0xdead000000000000000042069420694206942069'
  ];

  // 🔍 Log the direction
  console.log(`🔁 SELL CHECK: from=${fromAddr} to=${toAddr}`);

  if (!ROUTERS_LOWER.includes(toAddr)) {
    console.log('❌ Not a sell to router');
    return;
  }

  if (ROUTERS_LOWER.includes(fromAddr) || taxLikeAddresses.includes(fromAddr)) {
    console.log('❌ Sell from router or tax address');
    return;
  }

  const provider = getProvider();
  const code = await provider.getCode(fromAddr);
  if (code && code !== '0x') {
    console.log('❌ From address is a contract');
    return;
  }

  const tokenAmountRaw = parseFloat(formatUnits(amount, 18));
  console.log(`✅ Sell detected: ${tokenAmountRaw} tokens from ${fromAddr} → ${toAddr} [TX: ${log.transactionHash}]`);

  for (const token of tokenRows.filter(row => row.address.toLowerCase() === tokenAddress)) {
    const guild = client.guilds.cache.get(token.guild_id);
    if (!guild) continue;

    let channel = token.channel_id ? guild.channels.cache.get(token.channel_id) : null;
    if (!channel || !channel.isTextBased() || !channel.permissionsFor(guild.members.me).has('SendMessages')) {
      channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
    }
    if (channel) {
      const rawMsg = `🔴 SELL ALERT: ${tokenAmountRaw} ${token.name.toUpperCase()} tokens\nFrom: ${shortWalletLink(fromAddr)}\nTo: Router (${shortWalletLink(toAddr)})\nTX: https://basescan.org/tx/${log.transactionHash}`;
      console.log(`📣 Sending to ${channel.name} in ${guild.name}`);
      await channel.send(rawMsg).catch(err => {
        console.warn(`❌ Failed to send raw sell message: ${err.message}`);
      });
    } else {
      console.log(`❌ No valid channel in ${guild.name}`);
    }
  }
}


// 🔴 SELL HANDLER
async function handleTokenSellLog(client, tokenRows, log) {
  const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint amount)']);
  let parsed;
  try {
    parsed = iface.parseLog(log);
  } catch { return; }

  const { from, to, amount } = parsed.args;
  const fromAddr = from.toLowerCase();
  const toAddr = to.toLowerCase();

  const tokenAddress = log.address.toLowerCase();
  if (seenTx.has(log.transactionHash)) return;
  seenTx.add(log.transactionHash);

  const ROUTERS_LOWER = ROUTERS.map(r => r.toLowerCase());
  const taxLikeAddresses = [
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dEaD',
    '0xdead000000000000000042069420694206942069'
  ];

  if (!ROUTERS_LOWER.includes(toAddr)) return;
  if (ROUTERS_LOWER.includes(fromAddr) || taxLikeAddresses.includes(fromAddr)) return;

  const provider = getProvider();
  const code = await provider.getCode(fromAddr);
  if (code && code !== '0x') return;

  let usdGained = 0, ethGained = 0;
  try {
    const tx = await provider.getTransaction(log.transactionHash);
    const ethPrice = await getETHPrice();
    if (tx?.value) {
      ethGained = parseFloat(formatUnits(tx.value, 18));
      usdGained = ethGained * ethPrice;
    }
  } catch {}

  if (usdGained === 0 && ethGained === 0) return;

  const tokenAmountRaw = parseFloat(formatUnits(amount, 18));
  const tokenAmountFormatted = (tokenAmountRaw * 1000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const tokenPrice = await getTokenPriceUSD(tokenAddress);
  const marketCap = await getMarketCapUSD(tokenAddress);

  const rocketLine = '🔻💀🔻'.repeat(Math.max(1, Math.floor(tokenAmountRaw / 100)));
  const getColorByUsd = (usd) => usd < 10 ? 0x999999 : usd < 50 ? 0xff6600 : 0xff0000;

  for (const token of tokenRows.filter(row => row.address.toLowerCase() === tokenAddress)) {
    const guild = client.guilds.cache.get(token.guild_id);
    if (!guild) continue;
    let channel = token.channel_id ? guild.channels.cache.get(token.channel_id) : null;
    if (!channel || !channel.isTextBased() || !channel.permissionsFor(guild.members.me).has('SendMessages')) {
      channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
    }
    if (channel) {
      const embed = {
        title: `💥 ${token.name.toUpperCase()} Sell Detected!`,
        description: rocketLine,
        image: { url: 'https://iili.io/3tSeiEF.gif' },
        fields: [
          { name: '💰 Value', value: `$${usdGained.toFixed(4)} / ${ethGained.toFixed(4)} ETH`, inline: true },
          { name: '📤 Sold', value: `${tokenAmountFormatted} ${token.name.toUpperCase()}`, inline: true },
          { name: '💵 Price', value: `$${tokenPrice.toFixed(8)}`, inline: true },
          { name: '📊 MCap', value: marketCap ? `$${marketCap.toLocaleString()}` : 'Fetching...', inline: true }
        ],
        url: `https://www.geckoterminal.com/base/pools/${tokenAddress}`,
        color: getColorByUsd(usdGained),
        footer: { text: 'Live on Base • Powered by PimpsDev' },
        timestamp: new Date().toISOString()
      };
      await channel.send({ embeds: [embed] }).catch(() => {});
    }
  }
}

// ⚡ Prices
async function getETHPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    return parseFloat(data?.ethereum?.usd || '0');
  } catch { return 0; }
}

async function getTokenPriceUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${address}`);
    const data = await res.json();
    const prices = data?.data?.attributes?.token_prices || {};
    return parseFloat(prices[address.toLowerCase()] || '0');
  } catch { return 0; }
}

async function getMarketCapUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${address}`);
    const data = await res.json();
    return parseFloat(data?.data?.attributes?.fdv_usd || data?.data?.attributes?.market_cap_usd || '0');
  } catch { return 0; }
}

