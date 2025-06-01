const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getProvider } = require('../services/provider');
const contractListeners = require('../services/mintProcessor').contractListeners;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show system health and operational status'),

  async execute(interaction) {
    const client = interaction.client;
    const pg = client.pg;

    await interaction.deferReply();

    // DB Check
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

    // Discord Check
    let discordStatus = client.ws.status === 0 ? '🟢 Connected' : '🔴 Disconnected';

    // MintProcessor Check (listeners)
    let mintStatus = '🔴 No listeners';
    try {
      const active = Object.keys(contractListeners || {}).length;
      mintStatus = active > 0 ? `🟢 ${active} listener${active > 1 ? 's' : ''}` : '🟠 No active listeners';
    } catch {
      mintStatus = '🔴 Error';
    }

    const embed = new EmbedBuilder()
      .setTitle('📊 System Health Status')
      .setColor(0x00cc66)
      .addFields(
        { name: '🗄️ PostgreSQL', value: dbStatus, inline: true },
        { name: '📡 RPC Provider', value: `${rpcStatus} ${blockNum}`, inline: true },
        { name: '🤖 Discord Gateway', value: discordStatus, inline: true },
        { name: '🧱 Mint Processor', value: mintStatus, inline: true }
      )
      .setFooter({ text: 'Powered by PimpsDev — Status V1' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};
