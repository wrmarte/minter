// commands/mboptin.js
// ======================================================
// /mboptin — user opt-in to MuscleMB awareness pings + memory
// - Stores opted_in=true in mb_user_state
// - Safe: ephemeral response
// ======================================================

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mboptin')
    .setDescription('Opt-in to MuscleMB awareness pings (and lightweight activity memory).'),

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
      await MemoryStore.setOptIn(client, interaction.guild.id, interaction.user.id, true);

      await interaction.reply({
        content: '✅ You’re opted-in. MuscleMB can occasionally @mention you for check-ins. (You can opt out anytime with `/mboptout`.)',
        ephemeral: true
      });
    } catch (e) {
      console.warn('❌ /mboptin failed:', e?.message || String(e));
      await interaction.reply({ content: '⚠️ Failed to save your opt-in. Try again.', ephemeral: true }).catch(() => null);
    }
  }
};
