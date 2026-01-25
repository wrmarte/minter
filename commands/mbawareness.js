// commands/mbawareness.js
// ======================================================
// /mbawareness test — owner/admin-only, forces one awareness ping
// - Uses Awareness engine to pick an opted-in inactive user
// - If none qualifies, it will tell you why (ephemeral)
// ======================================================

const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

function isOwnerOrAdmin(interaction) {
  const ownerId = (process.env.BOT_OWNER_ID || '').trim();
  if (ownerId && interaction.user?.id === ownerId) return true;

  const member = interaction.member;
  const perms = member?.permissions;
  return Boolean(perms?.has?.(PermissionsBitField.Flags.Administrator));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mbawareness')
    .setDescription('MuscleMB awareness controls (admin/owner).')
    .addSubcommand(sc =>
      sc.setName('test').setDescription('Force one awareness ping (opt-in users only).')
    ),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: '⚠️ Use this in a server.', ephemeral: true }).catch(() => null);
    }

    if (!isOwnerOrAdmin(interaction)) {
      return interaction.reply({ content: '⛔ Admin/Owner only.', ephemeral: true }).catch(() => null);
    }

    const client = interaction.client;
    const pg = client?.pg;
    if (!pg?.query) {
      return interaction.reply({ content: '⚠️ DB not ready. Try again shortly.', ephemeral: true }).catch(() => null);
    }

    // If awareness is disabled, we still allow test (but we warn)
    const Awareness = require('../listeners/musclemb/awarenessEngine');
    const MemoryStore = require('../listeners/musclemb/memoryStore');

    try {
      await MemoryStore.ensureSchema(client);

      // Find a speakable channel to post in:
      // Prefer current channel if we can send there
      const channel = interaction.channel;
      if (!channel?.isTextBased?.()) {
        return interaction.reply({ content: '⚠️ This channel is not text-based.', ephemeral: true }).catch(() => null);
      }

      // Force build (ignores chance gate by temporarily faking env? no)
      // We’ll just call buildAwarenessPing; it still needs users to qualify.
      const guild = interaction.guild;

      // Build ping
      const ping = await Awareness.buildAwarenessPing(client, guild, channel);

      if (!ping?.content) {
        return interaction.reply({
          content:
            '⚠️ No awareness ping candidate found.\n' +
            'Make sure at least 1 user has run `/mboptin`, and they have been inactive long enough (MB_AWARENESS_INACTIVE_MS) and not pinged recently (MB_AWARENESS_PING_COOLDOWN_MS).',
          ephemeral: true
        }).catch(() => null);
      }

      // Send ping (allowed mention for that one user only)
      await channel.send({
        content: ping.content,
        allowedMentions: ping.allowedMentions || { parse: [] }
      });

      await interaction.reply({
        content: `✅ Awareness test fired.${Awareness.isEnabled() ? '' : ' (Note: MB_AWARENESS_ENABLED is OFF; this was a manual test.)'}`,
        ephemeral: true
      }).catch(() => null);

    } catch (e) {
      console.warn('❌ /mbawareness test failed:', e?.message || String(e));
      await interaction.reply({ content: '⚠️ Awareness test failed. Check logs.', ephemeral: true }).catch(() => null);
    }
  }
};
