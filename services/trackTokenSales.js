// /minter/services/trackTokenSales.js
const { JsonRpcProvider, Contract, Interface, formatUnits } = require('ethers');
const { EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

const BASE_RPC = 'https://mainnet.base.org';
const provider = new JsonRpcProvider(BASE_RPC);

const erc20Iface = new Interface([
  'event Transfer(address indexed from, address indexed to, uint amount)'
]);

const WETH = '0x4200000000000000000000000000000000000006';
const router = '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86';

module.exports = async function trackTokenSales(client) {
  const pg = client.pg;

  // Ensure the tracked_tokens table exists
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
          topics: [erc20Iface.getEventTopic('Transfer')]
        });

        for (const log of logs) {
          const parsed = erc20Iface.parseLog(log);
          const { from, to, amount } = parsed.args;

          if (from.toLowerCase() === router.toLowerCase()) {
            const tokenAmount = parseFloat(formatUnits(amount, 18));
            const tokenPrice = await getTokenPriceUSD(address);
            const usdValue = tokenAmount * tokenPrice;
            const marketCap = await getMarketCapUSD(address);

            const embed = new EmbedBuilder()
              .setTitle(`${name} Buy!`)
              .setDescription(`🟥🟦🚀🟥🟦🚀🟥🟦🚀`)
              .addFields(
                { name: '💸 Spent', value: `$${usdValue.toFixed(2)}`, inline: true },
                { name: '🎯 Got', value: `${tokenAmount.toLocaleString()} ${name}`, inline: true },
                { name: '💵 Price', value: `$${tokenPrice.toFixed(8)}`, inline: true },
                { name: '📊 MCap', value: `$${marketCap.toLocaleString()}`, inline: true }
              )
              .setColor(0xff4444)
              .setTimestamp();

            const guild = client.guilds.cache.get(guildId);
            if (!guild) continue;
            const channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
            if (channel) channel.send({ embeds: [embed] });
          }
        }
      } catch (err) {
        console.warn(`⚠️ Error checking token ${name}:`, err.message);
      }
    });
  }
};

async function getTokenPriceUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${address}`);
    const data = await res.json();
    return parseFloat(data?.data?.attributes?.token_prices?.usd || '0');
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

