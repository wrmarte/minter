const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getProvider } = require('../services/provider');
const { contractListeners } = require('../services/mintProcessorBase');
const { statSync } = require('fs');
const os = require('os');
const version = require('../package.json').version;

let mintProcessorStartTime = Date.now();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('📊 Display full system health overview'),

  async execute(interaction) {
    const client = interaction.client;
    const pg = client.pg;

    await interaction.deferReply();

    // ✅ Database
    let dbStatus = '🔴 Failed';
    try {
      await pg.query('SELECT 1');
      dbStatus = '🟢 Connected';
    } catch {}

    // ✅ RPC
    let rpcStatus = '🔴 Failed', blockNum = 'N/A';
    try {
      const block = await getProvider().getBlockNumber();
      rpcStatus = '🟢 Live';
      blockNum = `#${block}`;
    } catch {}

    // ✅ Discord Gateway
    const discordStatus = client.ws.status === 0 ? '🟢 Connected' : '🔴 Disconnected';

    // ✅ Mint Processor
    const activeListeners = Object.keys(contractListeners || {}).length;
    const mintStatus = activeListeners > 0 ? `🟢 ${activeListeners} Active` : '🟠 No listeners';

    // ✅ Slash Command Count
    let slashStatus = '🔴 0';
    try {
      const appCmds = await client.application.commands.fetch();
      slashStatus = appCmds.size > 0 ? `🟢 ${appCmds.size}` : '🔴 0';
    } catch {}

    // ✅ Guild Count
    const totalGuilds = client.guilds.cache.size;

    // ✅ Flex / Token / Contract Stats
    const getCount = async (query) => {
      try {
        const res = await pg.query(query);
        return parseInt(res.rows[0].count);
      } catch { return 0; }
    };

    const [flexProjects, nftContracts, tokensTracked] = await Promise.all([
      getCount('SELECT COUNT(*) FROM flex_projects'),
      getCount('SELECT COUNT(*) FROM contract_watchlist'),
      getCount('SELECT COUNT(*) FROM tracked_tokens')
    ]);

    // ✅ Uptime
    const formatUptime = (ms) => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      return `${h}h ${m}m`;
    };

    const uptime = formatUptime(process.uptime() * 1000);
    const mintUptime = formatUptime(Date.now() - mintProcessorStartTime);

    // ✅ Memory
    const memUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
    const memTotal = (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(1);
    const memoryUsage = `${memUsed} MB / ${memTotal} MB`;

    // ✅ Last Event
    let lastEventTime = 'N/A';
    try {
      const seenStats = statSync('./data/seen.json');
      lastEventTime = `<t:${Math.floor(seenStats.mtimeMs / 1000)}:R>`;
    } catch {}

    // ✅ Ping
    const ping = Date.now() - interaction.createdTimestamp;

    const embed = new EmbedBuilder()
      .setTitle('📊 Full System Status')
      .setColor(0x2ecc71)
      .setDescription([
        `🗄️ **Database** — ${dbStatus}`,
        `📡 **RPC Provider** — ${rpcStatus} (${blockNum})`,
        `📶 **Bot Ping** — ${ping}ms`,
        `🤖 **Discord Gateway** — ${discordStatus}`,
        `🧱 **Mint Processor** — ${mintStatus} *(Uptime: ${mintUptime})*`,
        `🌐 **Servers** — ${totalGuilds} Guilds`,
        `🔑 **Slash Commands** — ${slashStatus}`,
        `📦 **NFT Contracts Tracked** — ${nftContracts}`,
        `💰 **Tokens Tracked** — ${tokensTracked}`,
        `🎯 **Flex Projects** — ${flexProjects}`,
        `⏱️ **Last Event** — ${lastEventTime}`,
        `🧮 **Memory Usage** — ${memoryUsage}`,
        `🧪 **Bot Version** — v${version}`,
        `⏱️ **Total Uptime** — ${uptime}`
      ].join('\n'))
      .setFooter({ text: 'Powered by PimpsDev 🧪' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};















