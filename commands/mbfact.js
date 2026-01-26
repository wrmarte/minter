// commands/mbfact.js
const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const ProfileStore = require('../listeners/musclemb/profileStore');

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

function safeKey(k) {
  return String(k || '').trim().toLowerCase().replace(/[^a-z0-9_\-\.]/g, '').slice(0, 32);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mbfact')
    .setDescription('Admin-curated MuscleMB facts (key/value) per user')
    .addSubcommand(sc =>
      sc.setName('set')
        .setDescription('Set a fact for a user (admin/owner)')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('key').setDescription('Fact key (e.g. role, wallet)').setRequired(true))
        .addStringOption(o => o.setName('value').setDescription('Fact value').setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName('del')
        .setDescription('Delete a fact for a user (admin/owner)')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('key').setDescription('Fact key to delete').setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName('list')
        .setDescription('List facts for a user (self or admin/owner)')
        .addUserOption(o => o.setName('user').setDescription('Target user (default: you)').setRequired(false))
    ),

  async execute(interaction) {
    try {
      if (!interaction?.guildId) {
        await interaction.reply({ content: '⚠️ Use this in a server.', ephemeral: true });
        return;
      }

      const sub = interaction.options.getSubcommand();
      const client = interaction.client;
      const pg = client?.pg;

      if (!pg?.query) {
        await interaction.reply({ content: '⚠️ DB not ready. Try again in a moment.', ephemeral: true });
        return;
      }

      const isAdmin = isOwnerOrAdminInteraction(interaction);
      const guildId = String(interaction.guildId);

      const targetUser = interaction.options.getUser('user') || interaction.user;
      const targetUserId = String(targetUser.id);

      const viewingSelf = targetUserId === String(interaction.user.id);

      // Permissions:
      // - set/del => admin/owner only
      // - list => self allowed, others require admin
      if ((sub === 'set' || sub === 'del') && !isAdmin) {
        await interaction.reply({ content: '⛔ Admin/Owner only.', ephemeral: true });
        return;
      }
      if (sub === 'list' && !viewingSelf && !isAdmin) {
        await interaction.reply({ content: '⛔ You can only view your own facts.', ephemeral: true });
        return;
      }

      await ProfileStore.ensureSchema(client);

      if (sub === 'set') {
        const keyRaw = interaction.options.getString('key', true);
        const valueRaw = interaction.options.getString('value', true);

        const key = safeKey(keyRaw);
        if (!key) {
          await interaction.reply({ content: '⚠️ Invalid key. Use letters/numbers/_/./- only.', ephemeral: true });
          return;
        }

        const ok = await ProfileStore.setFact(
          client,
          guildId,
          targetUserId,
          key,
          valueRaw,
          String(interaction.user.id)
        );

        await interaction.reply({
          content: ok
            ? `✅ Saved fact for **${targetUser.username}**: \`${key}\` = "${String(valueRaw).trim().slice(0, 180)}"`
            : '⚠️ Failed to save fact.',
          ephemeral: true
        });
        return;
      }

      if (sub === 'del') {
        const keyRaw = interaction.options.getString('key', true);
        const key = safeKey(keyRaw);
        if (!key) {
          await interaction.reply({ content: '⚠️ Invalid key.', ephemeral: true });
          return;
        }

        const ok = await ProfileStore.deleteFact(client, guildId, targetUserId, key);

        await interaction.reply({
          content: ok
            ? `✅ Deleted fact \`${key}\` for **${targetUser.username}**.`
            : '⚠️ Failed to delete (or it didn’t exist).',
          ephemeral: true
        });
        return;
      }

      // list
      const facts = await ProfileStore.getFacts(client, guildId, targetUserId);

      const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle(`🧠 MB Facts — ${targetUser.username}`)
        .setDescription(
          facts.length
            ? facts.map(f => `• \`${f.key}\` = **${f.value}**`).join('\n')
            : '_No facts stored yet._'
        )
        .setFooter({ text: viewingSelf ? 'These are your facts (admin-curated).' : 'Admin-curated facts (per guild).' });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (e) {
      console.error('❌ /mbfact error:', e?.stack || e?.message || String(e));
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
