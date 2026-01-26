// commands/mboptin.js
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const MemoryStore = require('../listeners/musclemb/memoryStore');

function isOwnerOrAdminInteraction(interaction) {
  try {
    const ownerId = String(process.env.BOT_OWNER_ID || '').trim();
    const isOwner = ownerId && interaction.user?.id === ownerId;
    if (isOwner) return true;

    const perms = interaction.memberPermissions;
    return Boolean(perms?.has?.(PermissionsBitField.Flags.Administrator));
  } catch {
    return false;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mboptin')
    .setDescription('Opt-in/out of MuscleMB awareness pings (per server)')
    .addSubcommand(sc => sc.setName('on').setDescription('Opt-in (you)'))
    .addSubcommand(sc => sc.setName('off').setDescription('Opt-out (you)'))
    .addSubcommand(sc => sc.setName('status').setDescription('Show your opt-in status'))
    .addSubcommand(sc =>
      sc.setName('set')
        .setDescription('Admin: set opt-in for a user')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addBooleanOption(o => o.setName('enabled').setDescription('true=opt-in, false=opt-out').setRequired(true))
    ),

  async execute(interaction) {
    try {
      if (!interaction?.guildId) {
        await interaction.reply({ content: '⚠️ Use this in a server.', ephemeral: true });
        return;
      }

      const sub = interaction.options.getSubcommand();
      const client = interaction.client;

      if (!client?.pg?.query) {
        await interaction.reply({ content: '⚠️ DB not ready. Try again in a moment.', ephemeral: true });
        return;
      }

      const guildId = String(interaction.guildId);

      if (sub === 'set') {
        const isAdmin = isOwnerOrAdminInteraction(interaction);
        if (!isAdmin) {
          await interaction.reply({ content: '⛔ Admin/Owner only.', ephemeral: true });
          return;
        }

        const u = interaction.options.getUser('user', true);
        const enabled = interaction.options.getBoolean('enabled', true);

        const ok = await MemoryStore.setOptIn(client, guildId, String(u.id), Boolean(enabled));
        await interaction.reply({
          content: ok
            ? `✅ Set opt-in for **${u.username}** → **${enabled ? 'ON' : 'OFF'}**`
            : '⚠️ Failed to update opt-in.',
          ephemeral: true
        });
        return;
      }

      const userId = String(interaction.user.id);

      if (sub === 'on') {
        const ok = await MemoryStore.setOptIn(client, guildId, userId, true);
        await interaction.reply({
          content: ok ? '✅ You are now **opted-in** to awareness pings.' : '⚠️ Failed to opt-in.',
          ephemeral: true
        });
        return;
      }

      if (sub === 'off') {
        const ok = await MemoryStore.setOptIn(client, guildId, userId, false);
        await interaction.reply({
          content: ok ? '✅ You are now **opted-out** of awareness pings.' : '⚠️ Failed to opt-out.',
          ephemeral: true
        });
        return;
      }

      // status
      const on = await MemoryStore.userIsOptedIn(client, guildId, userId);
      await interaction.reply({
        content: `🧠 Awareness opt-in status: **${on ? 'ON' : 'OFF'}**`,
        ephemeral: true
      });
    } catch (e) {
      console.error('❌ /mboptin error:', e?.stack || e?.message || String(e));
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: '⚠️ Something went wrong.', ephemeral: true });
        } else {
          await interaction.reply({ content: '⚠️ Something went wrong.', ephemeral: true });
        }
      } catch {}
    }
  }
};
