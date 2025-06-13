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
    await handleTokenLog(client, tokenRows, log);
  }
};

async function handleTokenLog(client, tokenRows, log) {
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
  const taxOrBurn = [
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dEaD',
    '0xdead000000000000000042069420694206942069'
  ];

  // ❌ Filter unwanted transfers
  if (
    ROUTERS_LOWER.includes(fromAddr) && ROUTERS_LOWER.includes(toAddr)
  ) return; // router ➝ router (LP activity)

  if (taxOrBurn.includes(toAddr) || taxOrBurn.includes(fromAddr)) return;

  const provider = getProvider();
  const fromCode = await provider.getCode(fromAddr);
  const toCode = await provider.getCode(toAddr);
  if (fromCode !== '0x' || toCode !== '0x') return; // one side is a contract

  // 💰 Check ETH value to confirm real buy/sell
  let usdSpent = 0, ethSpent = 0;
  try {
    const tx = await provider.getTransaction(log.transactionHash);
    const ethPrice = await getETHPrice();
    if (tx?.value) {
      ethSpent = parseFloat(formatUnits(tx.value, 18));
      usdSpent = ethSpent * ethPrice;
    }
  } catch {}

  if (usdSpent === 0 && ethSpent === 0) return;

  const tokenAmountRaw = parseFloat(formatUnits(amount, 18));
  const tokenAmountFormatted = (tokenAmountRaw * 1000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  // 🧠 Estimate buy vs accumulate
  let buyLabel = '🆕 New Buy';
  try {
    const abi = ['function balanceOf(address account) view returns (uint256)'];
    const contract = new ethers.Contract(tokenAddress, abi, provider);
    const prevBalanceBN = await contract.balanceOf(toAddr, { blockTag: log.blockNumber - 1 });
    const prevBalance = parseFloat(formatUnits(prevBalanceBN, 18));
    if (prevBalance > 0) {
      const percentChange = ((tokenAmountRaw / prevBalance) * 100).toFixed(1);
      buyLabel = `🔁 +${percentChange}%`;
    }
  } catch (err) {
    console.warn(`⚠️ Failed to fetch previous balance for ${toAddr} on ${tokenAddress}: ${err.message}`);
  }

  const tokenPrice = await getTokenPriceUSD(tokenAddress);
  const marketCap = await getMarketCapUSD(tokenAddress);

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
          { name: '💸 Spent', value: `$${usdSpent.toFixed(4)} / ${ethSpent.toFixed(4)} ETH`, inline: true },
          { name: '🎯 Got', value: `${tokenAmountFormatted} ${token.name.toUpperCase()}`, inline: true },
          {
            name: buyLabel.startsWith('🆕') ? '🆕 New Buyer' : '🔁 Accumulated',
            value: buyLabel.replace(/^(🆕|🔁) /, ''),
            inline: true
          },
          { name: '💵 Price', value: `$${tokenPrice.toFixed(8)}`, inline: true },
          { name: '📊 MCap', value: marketCap ? `$${marketCap.toLocaleString()}` : 'Fetching...', inline: true }
        ],
        url: `https://www.geckoterminal.com/base/pools/${tokenAddress}`,
        color: getColorByUsdSpent(usdSpent),
        footer: { text: 'Live on Base • Powered by PimpsDev' },
        timestamp: new Date().toISOString()
      };
      await channel.send({ embeds: [embed] }).catch(err => {
        console.warn(`❌ Failed to send embed: ${err.message}`);
      });
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

