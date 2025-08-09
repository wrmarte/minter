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

  // ❌ Skip router-to-router or known tax/burn
  if (ROUTERS_LOWER.includes(fromAddr) && ROUTERS_LOWER.includes(toAddr)) return;
  if (taxOrBurn.includes(toAddr) || taxOrBurn.includes(fromAddr)) return;

  // ✅ Detect type
  const isBuy = ROUTERS_LOWER.includes(fromAddr) && !ROUTERS_LOWER.includes(toAddr);
  const isSell = !ROUTERS_LOWER.includes(fromAddr) && ROUTERS_LOWER.includes(toAddr);
  if (!isBuy && !isSell) return;

  // ⛔ Skip contract sell sources
  if (isSell) {
    const code = await getProvider().getCode(fromAddr);
    if (code !== '0x') {
      console.log(`⛔ Skipping contract sell from ${fromAddr}`);
      return;
    }
  }

  // 💰 Value tracking
  let usdSpent = 0, ethSpent = 0;
  try {
    const tx = await getProvider().getTransaction(log.transactionHash);
    const ethPrice = await getETHPrice();
    if (tx?.value) {
      ethSpent = parseFloat(formatUnits(tx.value, 18));
      usdSpent = ethSpent * ethPrice;
    }
  } catch {}

  const tokenAmountRaw = parseFloat(formatUnits(amount, 18));

  // ❌ Skip tiny tax reroutes
  if (usdSpent === 0 && ethSpent === 0 && tokenAmountRaw < 5) return;

  // ⛔ LP removal filter
  if (isBuy && usdSpent === 0 && ethSpent === 0) {
    try {
      const abi = ['function balanceOf(address account) view returns (uint256)'];
      const contract = new ethers.Contract(tokenAddress, abi, getProvider());
      const prevBalanceBN = await contract.balanceOf(toAddr, { blockTag: log.blockNumber - 1 });
      const prevBalance = parseFloat(formatUnits(prevBalanceBN, 18));
      if (prevBalance > 0) {
        console.log(`⛔ Skipping LP removal pretending to be a buy [${toAddr}]`);
        return;
      }
    } catch (err) {
      console.warn(`⚠️ LP filter failed: ${err.message}`);
    }
  }

  // 🧠 Buy label
  let buyLabel = isBuy ? '🆕 New Buy' : '💥 Sell';
  try {
    if (isBuy) {
      const abi = ['function balanceOf(address account) view returns (uint256)'];
      const contract = new ethers.Contract(tokenAddress, abi, getProvider());
      const prevBalanceBN = await contract.balanceOf(toAddr, { blockTag: log.blockNumber - 1 });
      const prevBalance = parseFloat(formatUnits(prevBalanceBN, 18));
      if (prevBalance > 0) {
        const percentChange = ((tokenAmountRaw / prevBalance) * 100).toFixed(1);
        buyLabel = `🔁 +${percentChange}%`;
      }
    }
  } catch {}

  const tokenPrice = await getTokenPriceUSD(tokenAddress);
  const marketCap = await getMarketCapUSD(tokenAddress);

  // 🔧 Display amount: keep your original ×1000, but if USD+price imply ~1000×, show implied instead
  let displayAmount = tokenAmountRaw * 1000; // original behavior
  try {
    if (usdSpent > 0 && tokenPrice > 0 && tokenAmountRaw > 0) {
      const implied = usdSpent / tokenPrice;          // tokens implied by USD/price
      const ratio = implied / tokenAmountRaw;         // how many times raw
      if (ratio > 800 && ratio < 1200) {              // roughly 1000× (±20%)
        displayAmount = implied;
      }
    }
  } catch {}
  const tokenAmountFormatted = displayAmount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const emojiLine = isBuy
    ? '🟥🟦🚀'.repeat(Math.max(1, Math.floor(tokenAmountRaw / 100)))
    : '🔻💀🔻'.repeat(Math.max(1, Math.floor(tokenAmountRaw / 100)));

  const getColorByUsd = (usd) => isBuy
    ? (usd < 10 ? 0xff0000 : usd < 20 ? 0x3498db : 0x00cc66)
    : (usd < 10 ? 0x999999 : usd < 50 ? 0xff6600 : 0xff0000);

  for (const token of tokenRows.filter(row => row.address.toLowerCase() === tokenAddress)) {
    const guild = client.guilds.cache.get(token.guild_id);
    if (!guild) continue;

    let channel = token.channel_id ? guild.channels.cache.get(token.channel_id) : null;
    if (!channel || !channel.isTextBased() || !channel.permissionsFor(guild.members.me).has('SendMessages')) {
      channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
    }

    if (channel) {
      const embed = {
        title: `${token.name.toUpperCase()} ${isBuy ? 'Buy' : 'Sell'}!`,
        description: emojiLine,
        image: { url: isBuy ? 'https://iili.io/3tSecKP.gif' : 'https://iili.io/3tSeiEF.gif' },
        fields: [
          {
            name: isBuy ? '💸 Spent' : '💰 Value',
            value: `$${usdSpent.toFixed(4)} / ${ethSpent.toFixed(4)} ETH`,
            inline: true
          },
          {
            name: isBuy ? '🎯 Got' : '📤 Sold',
            value: `${tokenAmountFormatted} ${token.name.toUpperCase()}`,
            inline: true
          },
          ...(isBuy
            ? [{
                name: buyLabel.startsWith('🆕') ? '🆕 New Buyer' : '🔁 Accumulated',
                value: buyLabel.replace(/^(🆕|🔁) /, ''),
                inline: true
              }]
            : []),
          { name: '💵 Price', value: `$${tokenPrice.toFixed(8)}`, inline: true },
          { name: '📊 MCap', value: marketCap ? `$${marketCap.toLocaleString()}` : 'Fetching...', inline: true }
        ],
        url: `https://www.geckoterminal.com/base/pools/${tokenAddress}`,
        color: getColorByUsd(usdSpent),
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




