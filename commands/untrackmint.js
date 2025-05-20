const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmint')
    .setDescription('Stop tracking a contract')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name').setRequired(true)),

  async execute(interaction, { pg }) {
    const name = interaction.options.getString('name');

    await pg.query(`DELETE FROM contract_watchlist WHERE name = $1`, [name]);

    return interaction.reply(`🛑 Stopped tracking **${name}**.`);
  }
};
