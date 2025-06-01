const { Interface, formatUnits } = require('ethers');
const fetch = require('node-fetch');
const { fetchLogs } = require('./logScanner');
const { getProvider } = require('./provider');
const { shortWalletLink } = require('../utils/helpers');

const ROUTERS = [
  '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
  '0x420dd381b31aef6683e2c581f93b119eee7e3f4d',
  '0xfbeef911dc5821886e1dda23b3e4f3eaffdd7930',
  '0x812e79c9c37eD676fdbdd1212D6a4e47EFfC6a42',
  '0xa5e0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  '0x95ebfcb1c6b345fda69cf56c51e30421e5a35aec'
];

// ✅ FULLY DISABLED seenTx
// const seenTx = new Set();

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
    await handleTokenLog(client, tokenRows, log);
  }
}

async function handleTokenLog(client, tokenRows, log) {
  const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint amount)']);
  let parsed;
  try {
    parsed = iface.parseLog(log);
  } catch { return; }

  const { from, to, amount } = parsed.args;
  const fromAddr = from.toLowerCase();

  if (!ROUTERS.includes(fromAddr)) return;
  if (to.toLowerCase() === '0x0000000000000000000000000000000000000000') return;
  // ✅ REMOVE THE DUPLICATION BLOCK
  // if (seenTx.has(log.transactionHash)) return;
  // seenTx.add(log.transactionHash);

  const tokenAmountRaw = parseFloat(formatUnits(amount, 18));
  const tokenAmountFormatted = (tokenAmountRaw * 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const tokenAddress = log.address.toLowerCase();
  const tokenPrice = await getTokenPriceUSD(tokenAddress);
  const marketCap = await getMarketCapUSD(tokenAddress);
  const ethPrice = await getETHPrice();

  const priceValid = tokenPrice > 0;
  const usdSpent = priceValid ? tokenAmountRaw * tokenPrice : 0;
  const ethSpent = priceValid && ethPrice > 0 ? usdSpent / ethPrice : 0;

  const rocketIntensity = Math.min(Math.floor(tokenAmountRaw / 100), 10);
  const rocketLine = '🟥🟦🚀'.repeat(Math.max(1, rocketIntensity));
  const getColorByUsdSpent = (usd) => usd < 10 ? 0xff0000 : usd < 20 ? 0x3498db : 0x00cc66;

  for (const token of tokenRows.filter(row => row.address.toLowerCase() === tokenAddress)) {
    const guild = client.guilds.cache.get(token.guild_id);
    if (!guild) continue;
    let channel = token.channel_id ? guild.channels.cache.get(token.channel_id) : null;
    if (!channel || !channel.isTextBased() || !channel.permissionsFor(guild.members.me).has('SendMessages')) {
      channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
    }
    if (channel) {
      const embed = {
        title: `${token.name.toUpperCase()} Buy!`,
        description: rocketLine,
        image: { url: 'https://iili.io/3tSecKP.gif' },
        fields: [
          { name: '💸 Spent', value: priceValid ? `$${usdSpent.toFixed(4)} / ${ethSpent.toFixed(4)} ETH` : 'N/A', inline: true },
          { name: '🎯 Got', value: `${tokenAmountFormatted} ${token.name.toUpperCase()}`, inline: true },
          { name: '💵 Price', value: priceValid ? `$${tokenPrice.toFixed(8)}` : 'N/A', inline: true },
          { name: '📊 MCap', value: marketCap ? `$${marketCap.toLocaleString()}` : 'Fetching...', inline: true }
        ],
        url: `https://www.geckoterminal.com/base/pools/${tokenAddress}`,
        color: getColorByUsdSpent(usdSpent),
        footer: { text: 'Live on Base • Powered by PimpsDev' },
        timestamp: new Date().toISOString()
      };
      await channel.send({ embeds: [embed] }).catch(() => {});
    }
  }
}

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







