const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getProvider } = require('../services/provider');
const { contractListeners } = require('../services/mintProcessorBase');
const { statSync } = require('fs');
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

    let dbStatus = '🔴 Failed';
    try {
      await pg.query('SELECT 1');
      dbStatus = '🟢 Connected';
    } catch {}

    let rpcStatus = '🔴 Failed';
    let blockNum = 'N/A';
    try {
      const block = await getProvider().getBlockNumber();
      rpcStatus = '🟢 Live';
      blockNum = `#${block}`;
    } catch {}

    const discordStatus = client.ws.status === 0 ? '🟢 Connected' : '🔴 Disconnected';

    let mintStatus = '🔴 Inactive';
    let activeListeners = 0;
    try {
      activeListeners = Object.keys(contractListeners || {}).length;
      mintStatus = activeListeners > 0 ? `🟢 ${activeListeners} Active` : '🟠 No listeners';
    } catch {}

    let commandCount = 0;
    try {
      const appCmds = await client.application.commands.fetch();
      commandCount = appCmds.size;
    } catch {}

    const totalGuilds = client.guilds.cache.size;

    let flexProjects = 0;
    try {
      const flexRes = await pg.query('SELECT COUNT(*) FROM flex_projects');
      flexProjects = parseInt(flexRes.rows[0].count);
    } catch {}

    let nftContracts = 0;
    try {
      const nftRes = await pg.query('SELECT COUNT(*) FROM contract_watchlist');
      nftContracts = parseInt(nftRes.rows[0].count);
    } catch {}

    let tokensTracked = 0;
    try {
      const tokenRes = await pg.query('SELECT COUNT(*) FROM tracked_tokens');
      tokensTracked = parseInt(tokenRes.rows[0].count);
    } catch {}

    const uptimeMs = process.uptime() * 1000;
    const uptime = `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`;

    const mintUptimeMs = Date.now() - mintProcessorStartTime;
    const mintUptime = `${Math.floor(mintUptimeMs / 3600000)}h ${Math.floor((mintUptimeMs % 3600000) / 60000)}m`;

    const memoryUsage = `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`;

    let lastEventTime = 'N/A';
    try {
      const seenStats = statSync('./data/seen.json');
      lastEventTime = `<t:${Math.floor(seenStats.mtimeMs / 1000)}:R>`;
    } catch {}

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
        `🔑 **Slash Commands** — ${commandCount}`,
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














