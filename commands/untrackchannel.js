const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackchannel')
    .setDescription('Remove this channel from a contract’s alerts')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name').setRequired(true)),

  async execute(interaction, { pg }) {
    const name = interaction.options.getString('name');
    const channelId = interaction.channel.id;

    const res = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);
    if (!res.rows.length) {
      return interaction.reply({ content: '❌ Contract not found.', ephemeral: true });
    }

    const filtered = res.rows[0].channel_ids.filter(id => id !== channelId);
    await pg.query(`UPDATE contract_watchlist SET channel_ids = $1 WHERE name = $2`, [filtered, name]);

    return interaction.reply(`✅ This channel was removed from **${name}** alerts.`);
  }
};
