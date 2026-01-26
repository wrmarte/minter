// commands/mbprofile.js
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
    .setName('mbprofile')
    .setDescription('View MuscleMB profile memory (facts + notes)')
    .addUserOption(o => o.setName('user').setDescription('Target user (default: you)').setRequired(false))
    .addIntegerOption(o => o.setName('notes').setDescription('How many notes (1-10)').setRequired(false)),

  async execute(interaction) {
    try {
      if (!interaction?.guildId) {
        await interaction.reply({ content: '⚠️ Use this in a server.', ephemeral: true });
        return;
      }

      const client = interaction.client;
      if (!client?.pg?.query) {
        await interaction.reply({ content: '⚠️ DB not ready. Try again in a moment.', ephemeral: true });
        return;
      }

      const guildId = String(interaction.guildId);
      const target = interaction.options.getUser('user') || interaction.user;
      const targetId = String(target.id);

      const viewingSelf = targetId === String(interaction.user.id);
      const isAdmin = isOwnerOrAdminInteraction(interaction);

      if (!viewingSelf && !isAdmin) {
        await interaction.reply({ content: '⛔ You can only view your own profile.', ephemeral: true });
        return;
      }

      await ProfileStore.ensureSchema(client);

      const facts = await ProfileStore.getFacts(client, guildId, targetId);
      const noteLimit = Math.max(1, Math.min(10, Number(interaction.options.getInteger('notes') || 4)));
      const notes = await ProfileStore.getNotes(client, guildId, targetId, noteLimit);

      const factsBlock = facts.length
        ? facts.map(f => `• \`${f.key}\` = **${f.value}**`).join('\n')
        : '_No facts stored._';

      const notesBlock = notes.length
        ? notes.map(n => `• **#${n.id}** ${fmtTs(n.createdAt)} — ${n.text}`).join('\n')
        : '_No notes stored._';

      const embed = new EmbedBuilder()
        .setColor('#9b59b6')
        .setTitle(`🧠 MB Profile — ${target.username}`)
        .addFields(
          { name: 'Facts', value: factsBlock.slice(0, 1000), inline: false },
          { name: 'Notes', value: notesBlock.slice(0, 1000), inline: false }
        )
        .setFooter({ text: 'Admin-curated memory (per guild). No auto-saving of message content.' });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (e) {
      console.error('❌ /mbprofile error:', e?.stack || e?.message || String(e));
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
