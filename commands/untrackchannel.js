const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackchannel')
    .setDescription('Stop this channel from tracking all contracts'),

  async execute(interaction, { pg }) {
    await interaction.deferReply({ ephemeral: true });

    const channelId = interaction.channel.id;

    try {
      await pg.query(`
        UPDATE contract_watchlist
        SET channel_ids = array_remove(channel_ids, $1)
        WHERE $1 = ANY(channel_ids)
      `, [channelId]);

      await interaction.editReply(`🛑 This channel has been removed from all contract tracking.`);
    } catch (err) {
      console.error('❌ Error untracking channel:', err);
      await interaction.editReply('❌ Could not untrack this channel.');
    }
  }
};
