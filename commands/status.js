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

    // Uptime
    const uptimeMs = process.uptime() * 1000;
    const uptimeHours = Math.floor(uptimeMs / 3600000);
    const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);
    const uptime = `${uptimeHours}h ${uptimeMinutes}m`;

    // Active servers
    const totalGuilds = client.guilds.cache.size;

    const embed = new EmbedBuilder()
      .setTitle('📊 Minter V4.4 System Status')
      .setColor(0x2ecc71)
      .setDescription([
        `🗄️ **Database** — ${dbStatus}`,
        `📡 **RPC Provider** — ${rpcStatus} (Block ${blockNum})`,
        `🤖 **Discord Gateway** — ${discordStatus}`,
        `🧱 **Mint Processor** — ${mintStatus}`,
        `🌐 **Active Servers** — ${totalGuilds} Guilds`,
        `⏱️ **Uptime** — ${uptime}`
      ].join('\n'))
      .setFooter({ text: 'Powered by PimpsDev • Status Monitor V4.4 🚀' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};


