// commands/mbnote.js
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

function fmtTs(d) {
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    return `<t:${Math.floor(dt.getTime() / 1000)}:R>`;
  } catch {
    return '';
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mbnote')
    .setDescription('Admin-curated MuscleMB notes (timestamped) per user')
    .addSubcommand(sc =>
      sc.setName('add')
        .setDescription('Add a note for a user (admin/owner)')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('note').setDescription('Short note').setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName('list')
        .setDescription('List notes for a user (self or admin/owner)')
        .addUserOption(o => o.setName('user').setDescription('Target user (default: you)').setRequired(false))
        .addIntegerOption(o => o.setName('limit').setDescription('How many (1-20)').setRequired(false))
    )
    .addSubcommand(sc =>
      sc.setName('del')
        .setDescription('Delete a note by ID (admin/owner)')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addStringOption(o => o.setName('id').setDescription('Note ID').setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName('clear')
        .setDescription('Delete ALL notes for a user (admin/owner)')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
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
      // - add/del/clear => admin/owner only
      // - list => self allowed, others require admin
      if ((sub === 'add' || sub === 'del' || sub === 'clear') && !isAdmin) {
        await interaction.reply({ content: '⛔ Admin/Owner only.', ephemeral: true });
        return;
      }
      if (sub === 'list' && !viewingSelf && !isAdmin) {
        await interaction.reply({ content: '⛔ You can only view your own notes.', ephemeral: true });
        return;
      }

      await ProfileStore.ensureSchema(client);

      if (sub === 'add') {
        const note = interaction.options.getString('note', true);
        const ok = await ProfileStore.addNote(
          client,
          guildId,
          targetUserId,
          note,
          String(interaction.user.id)
        );

        await interaction.reply({
          content: ok ? `✅ Added note for **${targetUser.username}**.` : '⚠️ Failed to add note.',
          ephemeral: true
        });
        return;
      }

      if (sub === 'del') {
        const id = interaction.options.getString('id', true);
        const ok = await ProfileStore.deleteNote(client, guildId, targetUserId, id);

        await interaction.reply({
          content: ok ? `✅ Deleted note **#${id}** for **${targetUser.username}**.` : '⚠️ Failed to delete (bad ID or missing).',
          ephemeral: true
        });
        return;
      }

      if (sub === 'clear') {
        // Direct clear (profileStore doesn’t have a helper; safe to do here)
        await pg.query(
          `DELETE FROM mb_profile_notes WHERE guild_id=$1 AND user_id=$2`,
          [guildId, targetUserId]
        );

        await interaction.reply({
          content: `✅ Cleared all notes for **${targetUser.username}**.`,
          ephemeral: true
        });
        return;
      }

      // list
      const limit = Math.max(1, Math.min(20, Number(interaction.options.getInteger('limit') || 6)));
      const notes = await ProfileStore.getNotes(client, guildId, targetUserId, limit);

      const lines = notes.length
        ? notes.map(n => `• **#${n.id}** ${fmtTs(n.createdAt)} — ${n.text}`).join('\n')
        : '_No notes stored yet._';

      const embed = new EmbedBuilder()
        .setColor('#f1c40f')
        .setTitle(`🗒️ MB Notes — ${targetUser.username}`)
        .setDescription(lines)
        .setFooter({ text: 'Notes are admin-curated (per guild).' });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (e) {
      console.error('❌ /mbnote error:', e?.stack || e?.message || String(e));
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
