// commands/rumble.js
const { SlashCommandBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const { openLobby } = require('../services/rumbleLobby');
const { runBracket } = require('../services/tourney');

const OWNER_ID = (process.env.BOT_OWNER_ID || '').trim();
const OWNER_ONLY = !/^false$/i.test(process.env.RUMBLE_OWNER_ONLY || 'true');

// tiny helper to avoid ephemeral deprecation across djs versions
async function safeReply(int, opts) {
  try {
    return await int.reply({ ...opts, flags: MessageFlags.Ephemeral });
  } catch {
    return await int.reply({ ...opts, ephemeral: true });
  }
}
async function safeFollowUp(int, opts) {
  try {
    return await int.followUp({ ...opts, flags: MessageFlags.Ephemeral });
  } catch {
    return await int.followUp({ ...opts, ephemeral: true });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rumble')
    .setDescription('Start a multi-player Rumble lobby (join/leave/invite, then bracket)')
    .addIntegerOption(o => o.setName('limit').setDescription('Max players (2-16)').setMinValue(2).setMaxValue(16))
    .addIntegerOption(o => o.setName('join_seconds').setDescription('Lobby time in seconds (10-120)').setMinValue(10).setMaxValue(120))
    .addIntegerOption(o => o.setName('best_of').setDescription('Odd number: 3/5/7').setChoices(
      {name:'3',value:3},{name:'5',value:5},{name:'7',value:7}
    ))
    .addStringOption(o => o.setName('style').setDescription('Commentary vibe').addChoices(
      {name:'clean',value:'clean'},{name:'motivator',value:'motivator'},
      {name:'villain',value:'villain'},{name:'degen',value:'degen'}
    )),

  async execute(interaction) {
    if (OWNER_ONLY && (!OWNER_ID || interaction.user.id !== OWNER_ID)) {
      return safeReply(interaction, { content: '🔒 /rumble is owner-only right now.' });
    }

    const limit = interaction.options.getInteger('limit') ?? 8;
    const joinSeconds = interaction.options.getInteger('join_seconds') ?? 30;
    const bestOf = interaction.options.getInteger('best_of') ?? 3;
    const style = (interaction.options.getString('style') || 'motivator').toLowerCase();

    await safeReply(interaction, { content: '🧩 Setting up lobby…' });

    // Notify host privately about permission fallbacks or where lobby is posted
    const notify = async (msg) => { try { await safeFollowUp(interaction, { content: msg }); } catch {} };

    // Verify perms (for a friendlier error)
    const ch = interaction.channel;
    const me = ch?.guild?.members?.me;
    const canSpeak = me && ch.permissionsFor(me)?.has(PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages | PermissionsBitField.Flags.EmbedLinks);
    if (!canSpeak) {
      await safeFollowUp(interaction, { content: 'Heads up: I might not be able to post here; I’ll try a different channel in this server.' });
    }

    const hostMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!hostMember) return safeFollowUp(interaction, { content: 'Could not fetch host.' });

    const players = await openLobby({
      channel: interaction.channel,
      hostMember,
      title: '🔔 Rumble Lobby',
      limit,
      joinSeconds,
      notify
    });

    if (players.length < 2) {
      return interaction.followUp({ content: 'Lobby ended without enough players.' });
    }

    await interaction.followUp({ content: `🎮 Starting bracket with **${players.length}** players…` });

    await runBracket({
      channel: interaction.channel,
      players,
      bestOf,
      style,
      guildName: interaction.guild?.name || 'this server'
    });
  }
};

