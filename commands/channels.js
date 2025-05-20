const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('channels')
    .setDescription('View all alert channels for a contract')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name').setRequired(true)),

  async execute(interaction, { pg }) {
    const name = interaction.options.getString('name');
    const res = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);

    if (!res.rows.length) {
      return interaction.reply({ content: '❌ Contract not found.', ephemeral: true });
    }

    const ids = res.rows[0].channel_ids;
    const mentions = ids.map(id => `<#${id}>`).join(', ');

    return interaction.reply(`🔔 **${name}** alerts go to: ${mentions}`);
  }
};
