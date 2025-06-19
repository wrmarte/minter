const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getProvider } = require('../services/provider');
const contractListeners = require('../services/mintProcessor').contractListeners;
const { statSync } = require('fs');
const fetch = require('node-fetch');
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
    } catch {
      dbStatus = '🔴 Failed';
    }

    let rpcStatus = '🔴 Failed';
    let blockNum = 'N/A';
    try {
      const block = await getProvider().getBlockNumber();
      rpcStatus = '🟢 Live';
      blockNum = `#${block}`;
    } catch {
      rpcStatus = '🔴 Failed';
    }

    const discordStatus = client.ws.status === 0 ? '🟢 Connected' : '🔴 Disconnected';

    let mintStatus = '🔴 Inactive';
    let activeListeners = 0;
    try {
      activeListeners = Object.keys(contractListeners || {}).length;
      mintStatus = activeListeners > 0 ? `🟢 ${activeListeners} Active` : '🟠 No listeners';
    } catch {
      mintStatus = '🔴 Error';
    }

    let commandCount = 0;
    try {
      const appCmds = await client.application.commands.fetch();
      commandCount = appCmds.size;
    } catch {
      commandCount = 0;
    }

    const totalGuilds = client.guilds.cache.size;

    let flexProjects = 0;
    try {
      const flexRes = await pg.query('SELECT COUNT(*) FROM flex_projects');
      flexProjects = parseInt(flexRes.rows[0].count);
    } catch {
      flexProjects = 0;
    }

    let nftContracts = 0;
    try {
      const nftRes = await pg.query('SELECT COUNT(*) FROM contract_watchlist');
      nftContracts = parseInt(nftRes.rows[0].count);
    } catch {
      nftContracts = 0;
    }

    let tokensTracked = 0;
    try {
      const tokenRes = await pg.query('SELECT COUNT(*) FROM tracked_tokens');
      tokensTracked = parseInt(tokenRes.rows[0].count);
    } catch {
      tokensTracked = 0;
    }

    const uptimeMs = process.uptime() * 1000;
    const uptimeHours = Math.floor(uptimeMs / 3600000);
    const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);
    const uptime = `${uptimeHours}h ${uptimeMinutes}m`;

    const mintUptimeMs = Date.now() - mintProcessorStartTime;
    const mintUptimeHours = Math.floor(mintUptimeMs / 3600000);
    const mintUptimeMinutes = Math.floor((mintUptimeMs % 3600000) / 60000);
    const mintUptime = `${mintUptimeHours}h ${mintUptimeMinutes}m`;

    const memoryUsage = `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`;

    let lastEventTime = 'N/A';
    try {
      const seenStats = statSync('./data/seen.json');
      lastEventTime = `<t:${Math.floor(seenStats.mtimeMs / 1000)}:R>`;
    } catch {}

    let flexcardStatus = '🟠 Unknown';
    try {
      const flexPing = await fetch('https://api.flexcard.healthcheck'); // optional real health check
      flexcardStatus = flexPing.ok ? '🟢 OK' : '🔴 Error';
    } catch {
      flexcardStatus = '🔴 Error';
    }

    const ping = Date.now() - interaction.createdTimestamp;

    const embed = new EmbedBuilder()
      .setTitle('📊 Full System Status')
      .setColor(0x2ecc71)
      .setDescription([
        `🗄️ **Database** — ${dbStatus}`,
        `📡 **RPC Provider** — ${rpcStatus} (Block ${blockNum})`,
        `🎨 **FlexCard Generator** — ${flexcardStatus}`,
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






