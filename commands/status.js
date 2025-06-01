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
    try {
      const active = Object.keys(contractListeners || {}).length;
      mintStatus = active > 0 ? `🟢 ${active} Active` : '🟠 No listeners';
    } catch {
      mintStatus = '🔴 Error';
    }

    // Embed display (clean vertical layout)
    const embed = new EmbedBuilder()
      .setTitle('📊 Bot System Status')
      .setColor(0x3498db)
      .setDescription([
        `🗄️ **PostgreSQL:** ${dbStatus}`,
        `📡 **RPC Provider:** ${rpcStatus} *(Block ${blockNum})*`,
        `🤖 **Discord Gateway:** ${discordStatus}`,
        `🧱 **Mint Processor:** ${mintStatus}`,
        `\u200b` // empty line for spacing
      ].join('\n'))
      .setFooter({ text: 'PimpsDev • Status Monitor v1.0' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};

