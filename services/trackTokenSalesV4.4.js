const { Interface, formatUnits, id } = require('ethers');
const { EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { getProvider, rotateProvider } = require('./provider');
const { fetchLogs } = require('./logScanner');

// --- Interfaces and constants ---
const erc20Iface = new Interface([
  'event Transfer(address indexed from, address indexed to, uint amount)'
]);

const ROUTERS = [
  '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
  '0x420dd381b31aef6683e2c581f93b119eee7e3f4d',
  '0xfbeef911dc5821886e1dda23b3e4f3eaffdd7930',
  '0x812e79c9c37eD676fdbdd1212D6a4e47EFfC6a42',
  '0xa5e0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  '0x95ebfcb1c6b345fda69cf56c51e30421e5a35aec'
];

const ROUTERS_SET = new Set(ROUTERS.map(a => a.toLowerCase()));
const SWAP_TOPIC_V2 = id('Swap(address,uint256,uint256,uint256,uint256,address)');
const SWAP_TOPIC_V3 = id('Swap(address,address,int256,int256,uint160,uint128,int24)');

const seenTx = new Set();

module.exports = async function trackTokenSales(client) {
  const pg = client.pg;

  await pg.query(`
    CREATE TABLE IF NOT EXISTS tracked_tokens (
      name TEXT,
      address TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT,
      PRIMARY KEY (address, guild_id)
    )
  `);

  const res = await pg.query(`SELECT * FROM tracked_tokens`);
  const tracked = res.rows;

  const addressMap = new Map();
  for (const token of tracked) {
    const addr = token.address.toLowerCase();
    if (!addressMap.has(addr)) {
      addressMap.set(addr, []);
    }
    addressMap.get(addr).push(token);
  }

  for (const [address, tokenGroup] of addressMap.entries()) {
    const contractAddress = address;
    const transferTopic = erc20Iface.getEvent('Transfer').topicHash;

    getProvider().on('block', async (blockNumber) => {
      const fromBlock = Math.max(blockNumber - 5, 0);
      const toBlock = blockNumber;

      let logs = [];

      try {
        logs = await fetchLogs(contractAddress, fromBlock, toBlock, transferTopic);
      } catch (err) {
        console.warn(`⚠️ fetchLogs failed: ${err.message}`);
        return;
      }

      for (const log of logs) {
        if (seenTx.has(log.transactionHash)) continue;
        seenTx.add(log.transactionHash);

        let parsed;
        try {
          parsed = erc20Iface.parseLog(log);
        } catch {
          continue;
        }

        const { from, to, amount } = parsed.args;
        const fromAddr = from.toLowerCase();
        if (to.toLowerCase() === '0x0000000000000000000000000000000000000000') continue;

        // Primary check: direct router -> buy
        let isBuy = ROUTERS_SET.has(fromAddr);

        // Secondary check: if not direct router, check tx receipt logs for swap/router activity (pair flows)
        if (!isBuy) {
          try {
            const receipt = await getProvider().getTransactionReceipt(log.transactionHash);
            if (receipt && receipt.logs) {
              for (const lg of receipt.logs) {
                const lgAddr = (lg.address || '').toLowerCase();
                if (ROUTERS_SET.has(lgAddr)) {
                  isBuy = true;
                  break;
                }
                if (lg.topics && lg.topics.length > 0) {
                  const t0 = lg.topics[0];
                  if (t0 === SWAP_TOPIC_V2 || t0 === SWAP_TOPIC_V3) {
                    isBuy = true;
                    break;
                  }
                }
              }
            }
          } catch {}
        }

        if (!isBuy) continue;

        const tokenAmountRaw = parseFloat(formatUnits(amount, 18));
        const tokenAmountFormatted = (tokenAmountRaw * 1000).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });

        const tokenPrice = await getTokenPriceUSD(address);
        const marketCap = await getMarketCapUSD(address);

        let usdSpent = 0;
        let ethSpent = 0;

        try {
          const tx = await getProvider().getTransaction(log.transactionHash);
          const ethPrice = await getETHPrice();
          if (tx?.value && tx.value > 0n) {
            ethSpent = parseFloat(formatUnits(tx.value, 18));
            usdSpent = ethSpent * ethPrice;
          } else {
            // fallback: approximate USD spent by token amount * token price (best-effort)
            usdSpent = tokenAmountRaw * tokenPrice;
            ethSpent = 0;
          }
        } catch (err) {
          console.warn(`⚠️ TX fetch failed: ${err.message}`);
        }

        const rocketIntensity = Math.min(Math.floor(tokenAmountRaw / 100), 10);
        const rocketLine = '🟥🟦🚀'.repeat(Math.max(1, rocketIntensity));

        const getColorByUsdSpent = (usd) => {
          if (usd < 10) return 0xff0000;
          if (usd < 20) return 0x3498db;
          return 0x00cc66;
        };

        const embedColor = getColorByUsdSpent(usdSpent);

        for (const token of tokenGroup) {
          const guildId = token.guild_id;
          const trackedChannelId = token.channel_id;
          const name = token.name.toUpperCase();

          const embed = new EmbedBuilder()
            .setTitle(`${name} Buy!`)
            .setDescription(`${rocketLine}`)
            .setImage('https://iili.io/3tSecKP.gif')
            .addFields(
              { name: '💸 Spent', value: `$${usdSpent.toFixed(4)} / ${ethSpent.toFixed(4)} ETH`, inline: true },
              { name: '🎯 Got', value: `${tokenAmountFormatted} ${name}`, inline: true },
              { name: '💵 Price', value: `$${tokenPrice.toFixed(8)}`, inline: true },
              { name: '📊 MCap', value: marketCap && marketCap > 0 ? `$${marketCap.toLocaleString()}` : 'Fetching...', inline: true }
            )
            .setURL(`https://www.geckoterminal.com/base/pools/${address}`)
            .setColor(embedColor)
            .setFooter({ text: 'Live on Base • Powered by PimpsDev' })
            .setTimestamp();

          const guild = client.guilds.cache.get(guildId);
          if (!guild) continue;

          let channel = null;

          if (trackedChannelId) {
            channel = guild.channels.cache.get(trackedChannelId);
          }

          if (!channel || !channel.isTextBased() || !channel.permissionsFor(guild.members.me).has('SendMessages')) {
            channel = guild.channels.cache.find(c =>
              c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages')
            );
          }

          if (channel) {
            await channel.send({ embeds: [embed] });
          }
        }
      }
    });
  }
};

async function getETHPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    return parseFloat(data?.ethereum?.usd || '0');
  } catch {
    return 0;
  }
}

async function getTokenPriceUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${address}`);
    const data = await res.json();
    const prices = data?.data?.attributes?.token_prices || {};
    return parseFloat(prices[address.toLowerCase()] || '0');
  } catch {
    return 0;
  }
}

async function getMarketCapUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${address}`);
    const data = await res.json();
    return parseFloat(data?.data?.attributes?.fdv_usd || data?.data?.attributes?.market_cap_usd || '0');
  } catch {
    return 0;
  }
}



















