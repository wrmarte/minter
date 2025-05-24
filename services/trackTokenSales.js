const { JsonRpcProvider, Contract, Interface, formatUnits } = require('ethers');
const { EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

const BASE_RPC = 'https://mainnet.base.org';
const provider = new JsonRpcProvider(BASE_RPC);

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

const seenTx = new Set();

module.exports = async function trackTokenSales(client) {
  const pg = client.pg;

  await pg.query(`
    CREATE TABLE IF NOT EXISTS tracked_tokens (
      name TEXT,
      address TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      PRIMARY KEY (address, guild_id)
    )
  `);

  const res = await pg.query(`SELECT * FROM tracked_tokens`);
  const tracked = res.rows;

  for (const token of tracked) {
    const address = token.address.toLowerCase();
    const name = token.name.toUpperCase();
    const guildId = token.guild_id;

    let lastBlock = await provider.getBlockNumber();

    provider.on('block', async (blockNumber) => {
      if (blockNumber === lastBlock) return;
      lastBlock = blockNumber;

      try {
        const logs = await provider.getLogs({
          address,
          fromBlock: blockNumber - 1,
          toBlock: blockNumber,
          topics: [erc20Iface.getEvent('Transfer').topicHash]
        });

        for (const log of logs) {
          if (seenTx.has(log.transactionHash)) continue;
          seenTx.add(log.transactionHash);

          const parsed = erc20Iface.parseLog(log);
          const { from, to, amount } = parsed.args;

          const fromAddr = from.toLowerCase();
          if (!ROUTERS.includes(fromAddr)) continue;
          if (to.toLowerCase() === '0x0000000000000000000000000000000000000000') continue;

          const tokenAmount = parseFloat(formatUnits(amount, 18));
          const tokenPrice = await getTokenPriceUSD(address);
          const marketCap = await getMarketCapUSD(address);

          let usdSpent = 0;
          let ethSpent = 0;

          try {
            const tx = await provider.getTransaction(log.transactionHash);
            const ethPrice = await getETHPrice();

            if (tx?.value) {
              ethSpent = parseFloat(formatUnits(tx.value, 18));
              usdSpent = ethSpent * ethPrice;
            }
          } catch (err) {
            console.warn(`⚠️ TX fetch failed: ${err.message}`);
          }

          const intensity = Math.max(1, Math.floor(usdSpent / 5));
          const rocketLine = '🟥🟦🚀'.repeat(intensity);

          const embed = new EmbedBuilder()
            .setTitle(`${name} Buy!`)
            .setDescription(`${rocketLine}`)
            .setImage('https://iili.io/3tSecKP.gif')
            .addFields(
              { name: '💸 Spent', value: `$${usdSpent.toFixed(4)} / ${ethSpent.toFixed(4)} ETH`, inline: true },
              { name: '🎯 Got', value: `${tokenAmount.toLocaleString()} ${name}`, inline: true },
              { name: '💵 Price', value: `$${tokenPrice.toFixed(8)}`, inline: true },
              { name: '📊 MCap', value: marketCap && marketCap > 0 ? `$${marketCap.toLocaleString()}` : 'Fetching...', inline: true }
            )
            .setURL(`https://www.geckoterminal.com/base/pools/${address}`)
            // Dynamic Red-Blue blend based on intensity
function getRedBlueBlendColor(intensity) {
  const maxIntensity = 50; // You can adjust this cap
  const clampedIntensity = Math.min(intensity, maxIntensity);
  const red = Math.floor(255 * (clampedIntensity / maxIntensity));
  const blue = 255 - red;
  return (red << 16) + (0 << 8) + blue; // RGB to decimal
}

const embedColor = getRedBlueBlendColor(intensity);

const embed = new EmbedBuilder()
  .setTitle(`${name} Buy!`)
  .setDescription(`${rocketLine}`)
  .setImage('https://iili.io/3tSecKP.gif')
  .addFields(
    { name: '💸 Spent', value: `$${usdSpent.toFixed(4)} / ${ethSpent.toFixed(4)} ETH`, inline: true },
    { name: '🎯 Got', value: `${tokenAmount.toLocaleString()} ${name}`, inline: true },
    { name: '💵 Price', value: `$${tokenPrice.toFixed(8)}`, inline: true },
    { name: '📊 MCap', value: marketCap && marketCap > 0 ? `$${marketCap.toLocaleString()}` : 'Fetching...', inline: true }
  )
  .setURL(`https://www.geckoterminal.com/base/pools/${address}`)
  .setColor(embedColor)
  .setFooter({ text: 'Live on Base • Powered by PimpsDev' })
  .setTimestamp();

            .setFooter({ text: 'Live on Base • Powered by PimpsDev' })
            .setTimestamp();

          const guild = client.guilds.cache.get(guildId);
          if (!guild) continue;
          const channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
          if (channel) await channel.send({ embeds: [embed] });
        }
      } catch (err) {
        console.warn(`⚠️ Error checking token ${name}:`, err.message);
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
    const price = prices[address.toLowerCase()];
    return parseFloat(price || '0');
  } catch {
    return 0;
  }
}

async function getMarketCapUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${address}`);
    const data = await res.json();
    const mcap = data?.data?.attributes?.fdv_usd || data?.data?.attributes?.market_cap_usd || '0';
    return parseFloat(mcap);
  } catch {
    return 0;
  }
}














