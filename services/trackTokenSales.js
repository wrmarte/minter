// /minter/services/trackTokenSales.js
const { JsonRpcProvider, Contract, Interface, formatUnits } = require('ethers');
const { EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

const BASE_RPC = 'https://mainnet.base.org';
const provider = new JsonRpcProvider(BASE_RPC);

const erc20Iface = new Interface([
  'event Transfer(address indexed from, address indexed to, uint amount)'
]);

// List of known routers (Uniswap v2, v3, Sushi, etc. on Base)
const ROUTERS = [
  '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86', // Uniswap V2
  '0x0000000000000000000000000000000000000000', // Example, replace with real
  '0x5615CDAb10dc425a742d643d949a7F474C01abc4', // Alien Base
  '0xa49d7499271cc2cda79ffdb78d2c975f3a34db38', // Aerodrome
  '0x8df340de57c02d8df8d7c3eb6a4267e4de7e3e6e', // Velodrome V2
  '0xc161a4ca5c8edc5d880a76d3907b3c2d1a4b0317'  // SushiSwap (example)
];

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
          topics: [erc20Iface.getEvent('Transfer').topicHash]
        });

        for (const log of logs) {
          const parsed = erc20Iface.parseLog(log);
          const { from, to, amount } = parsed.args;

          const isRouter = ROUTERS.some(router => router.toLowerCase() === from.toLowerCase());
          if (isRouter) {
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




