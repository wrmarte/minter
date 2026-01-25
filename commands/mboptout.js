// commands/mboptout.js
// ======================================================
// /mboptout — user opt-out from MuscleMB awareness pings + memory pings
// - Stores opted_in=false in mb_user_state
// - Safe: ephemeral response
// ======================================================

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mboptout')
    .setDescription('Opt-out of MuscleMB awareness pings.'),

  async execute(interaction) {
    const client = interaction.client;
    const pg = client?.pg;

    if (!interaction.guild) {
      return interaction.reply({ content: '⚠️ This command only works in a server.', ephemeral: true }).catch(() => null);
    }

    if (!pg?.query) {
      return interaction.reply({ content: '⚠️ DB not ready. Try again in a moment.', ephemeral: true }).catch(() => null);
    }

    const MemoryStore = require('../listeners/musclemb/memoryStore');

    try {
      await MemoryStore.ensureSchema(client);
      await MemoryStore.setOptIn(client, interaction.guild.id, interaction.user.id, false);

      await interaction.reply({
        content: '🛑 You’re opted-out. MuscleMB will not @mention you for awareness check-ins.',
        ephemeral: true
      });
    } catch (e) {
      console.warn('❌ /mboptout failed:', e?.message || String(e));
      await interaction.reply({ content: '⚠️ Failed to save your opt-out. Try again.', ephemeral: true }).catch(() => null);
    }
  }
};
