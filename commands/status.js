const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getProvider } = require('../services/provider');
const contractListeners = require('../services/mintProcessor').contractListeners;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('📊 Display full system health overview'),

  async execute(interaction) {
    const client = interaction.client;
    const pg = client.pg;

    await interaction.deferReply();

    // Database Check
    let dbStatus = '🔴 Failed';
    try {
      await pg.query('SELECT 1');
      dbStatus = '🟢 Connected';
    } catch {
      dbStatus = '🔴 Failed';
    }

    // RPC Check
    let rpcStatus = '🔴 Failed';
    let blockNum = 'N/A';
    try {
      const block = await getProvider().getBlockNumber();
      rpcStatus = '🟢 Live';
      blockNum = `#${block}`;
    } catch {
      rpcStatus = '🔴 Failed';
    }

    // Discord Gateway Check
    let discordStatus = client.ws.status === 0 ? '🟢 Connected' : '🔴 Disconnected';

    // Mint Processor Check (active listeners)
    let mintStatus = '🔴 Inactive';
    let activeListeners = 0;
    try {
      activeListeners = Object.keys(contractListeners || {}).length;
      mintStatus = activeListeners > 0 ? `🟢 ${activeListeners} Active` : '🟠 No listeners';
    } catch {
      mintStatus = '🔴 Error';
    }

    // Slash Commands Registered (fix)
    let commandCount = 0;
    try {
      const appCmds = await client.application.commands.fetch();
      commandCount = appCmds.size;
    } catch {
      commandCount = 0;
    }

    // Total servers
    const totalGuilds = client.guilds.cache.size;

    // Flex Projects Count
    let flexProjects = 0;
    try {
      const flexRes = await pg.query('SELECT COUNT(*) FROM flex_projects');
      flexProjects = flexRes.rows[0].count;
    } catch {
      flexProjects = 0;
    }

    // NFT Contracts Tracked (from contract_watchlist)
    let nftContracts = 0;
    try {
      const nftRes = await pg.query('SELECT COUNT(*) FROM contract_watchlist');
      nftContracts = nftRes.rows[0].count;
    } catch {
      nftContracts = 0;
    }

    // Tokens Tracked (safe fallback if table doesn't exist)
    let tokensTracked = 0;
    try {
      const tokenRes = await pg.query('SELECT COUNT(*) FROM token_watchlist');
      tokensTracked = tokenRes.rows[0].count;
    } catch {
      tokensTracked = 0;
    }

    // Uptime
    const uptimeMs = process.uptime() * 1000;
    const uptimeHours = Math.floor(uptimeMs / 3600000);
    const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);
    const uptime = `${uptimeHours}h ${uptimeMinutes}m`;

    // Node.js Memory Usage
    const memoryUsage = `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`;

    const embed = new EmbedBuilder()
      .setTitle('📊 Full System Status')
      .setColor(0x2ecc71)
      .setDescription([
        `🗄️ **Database** — ${dbStatus}`,
        `📡 **RPC Provider** — ${rpcStatus} (Block ${blockNum})`,
        `🤖 **Discord Gateway** — ${discordStatus}`,
        `🧱 **Mint Processor** — ${mintStatus}`,
        `🌐 **Servers** — ${totalGuilds} Guilds`,
        `🔑 **Slash Commands** — ${commandCount}`,
        `📦 **NFT Contracts Tracked** — ${nftContracts}`,
        `💰 **Tokens Tracked** — ${tokensTracked}`,
        `🎯 **Flex Projects** — ${flexProjects}`,
        `🧮 **Memory Usage** — ${memoryUsage}`,
        `⏱️ **Uptime** — ${uptime}`
      ].join('\n'))
      .setFooter({ text: 'Powered by PimpsDev 🧪' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};




