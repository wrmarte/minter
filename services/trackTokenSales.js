const { JsonRpcProvider, Contract, Interface, formatUnits } = require('ethers');
const { EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

const BASE_RPC = 'https://mainnet.base.org';
const provider = new JsonRpcProvider(BASE_RPC);

const erc20Iface = new Interface([
  'event Transfer(address indexed from, address indexed to, uint amount)'
]);

const ROUTERS = [
  '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', // Uniswap
  '0x420dd381b31aef6683e2c581f93b119eee7e3f4d', // Aerodrome
  '0xfbeef911dc5821886e1dda23b3e4f3eaffdd7930', // AlienBase
  '0x812e79c9c37eD676fdbdd1212D6a4e47EFfC6a42', // Sushi
  '0xa5e0829CaCEd8fFDD4De3c43696c57F7D7A678ff', // Other
  '0x95ebfcb1c6b345fda69cf56c51e30421e5a35aec'  // Detected real router
];

const seenHashes = new Set();

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

    const contract = new Contract(address, erc20Iface, provider);
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
          if (seenHashes.has(log.transactionHash)) continue;
          seenHashes.add(log.transactionHash);

          const parsed = erc20Iface.parseLog(log);
          const { from, to, amount } = parsed.args;

          const fromAddr = from.toLowerCase();
          const toAddr = to.toLowerCase();
          if (!ROUTERS.includes(fromAddr)) continue;
          if (toAddr === '0x0000000000000000000000000000000000000000') continue;

          const tokenAmount = parseFloat(formatUnits(amount, 18));
          const tokenPrice = await getTokenPriceUSD(address);
          const usdValue = tokenAmount * tokenPrice;

          const ethPrice = await getETHPrice();
          const ethValue = ethPrice > 0 ? usdValue / ethPrice : 0;

          const marketCap = await getMarketCapUSD(address);

          const embed = new EmbedBuilder()
            .setTitle(`${name} Buy!`)
            .setDescription(`🟥🟦🚀🟥🟦🚀🟥🟦🚀`)
            .addFields(
              { name: '💸 Spent', value: `$${usdValue.toFixed(2)} / ${ethValue.toFixed(4)} ETH`, inline: true },
              { name: '🎯 Got', value: `${tokenAmount.toLocaleString()} ${name}`, inline: true },
              { name: '💵 Price', value: `$${tokenPrice.toFixed(8)}`, inline: true },
              { name: '📊 MCap', value: `$${marketCap.toLocaleString()}`, inline: true }
            )
            .setColor(0x3498db)
            .setFooter({ text: 'Live on Base • Powered by PimpsDev' })
            .setTimestamp();

          const guild = client.guilds.cache.get(guildId);
          if (!guild) continue;
          const channel = guild.channels.cache.find(c =>
            c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages')
          );
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
    const prices = data?.data?.attributes?.token_prices;
    const price = prices ? Object.values(prices)[0] : '0';
    return parseFloat(price);
  } catch {
    return 0;
  }
}

async function getMarketCapUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${address}`);
    const data = await res.json();
    return parseFloat(data?.data?.attributes?.market_cap_usd || '0');
  } catch {
    return 0;
  }
}



















