const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('channels')
    .setDescription('View all alert channels for a contract')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Contract name')
        .setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name');

    try {
      const result = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);

      if (!result.rows.length) {
        return interaction.reply({ content: `❌ Contract **${name}** not found.`, ephemeral: true });
      }

      const ids = result.rows[0].channel_ids || [];
      if (!ids.length) {
        return interaction.reply({ content: `📭 No channels are subscribed to **${name}** yet.`, ephemeral: true });
      }

      const mentions = ids.map(id => `<#${id}>`).join(', ');
      return interaction.reply(`🔔 **${name}** is sending alerts to:\n${mentions}`);
    } catch (err) {
      console.error(`❌ Error in /channels:`, err);
      return interaction.reply({ content: '⚠️ Something went wrong executing `/channels`.', ephemeral: true });
    }
  }
};
