const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('channels')
    .setDescription('List which contracts are tracked in which channels'),

  async execute(interaction, { pg }) {
    await interaction.deferReply();

    try {
      const { rows } = await pg.query('SELECT * FROM contract_watchlist');
      if (!rows.length) {
        return interaction.editReply('No contracts are currently being tracked.');
      }

      const response = rows.map(row => {
        return `🔗 \`${row.contract_address}\`\n📺 Channels: ${row.channel_ids.map(id => `<#${id}>`).join(', ')}`;
      }).join('\n\n');

      await interaction.editReply({ content: response });
    } catch (err) {
      console.error('❌ Error listing tracked channels:', err);
      await interaction.editReply('❌ Could not retrieve tracked contracts.');
    }
  }
};

