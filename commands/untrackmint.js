const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmint')
    .setDescription('Stop tracking a contract')
    .addStringOption(option =>
      option.setName('contract')
        .setDescription('Contract address to untrack')
        .setRequired(true)),

  async execute(interaction, { pg }) {
    await interaction.deferReply({ ephemeral: true });

    const contract = interaction.options.getString('contract');
    const channelId = interaction.channel.id;

    try {
      await pg.query(`
        UPDATE contract_watchlist
        SET channel_ids = array_remove(channel_ids, $2)
        WHERE contract_address = $1
      `, [contract.toLowerCase(), channelId]);

      await interaction.editReply(`✅ Stopped tracking \`${contract}\` in this channel.`);
    } catch (err) {
      console.error(err);
      await interaction.editReply('❌ Failed to untrack contract.');
    }
  }
};
