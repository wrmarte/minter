// commands/rumble.js
const { SlashCommandBuilder } = require('discord.js');
const { openLobby } = require('../services/rumbleLobby');
const { runBracket } = require('../services/tourney');

const OWNER_ID = (process.env.BOT_OWNER_ID || '').trim();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rumble')
    .setDescription('Start a multi-player Rumble lobby (owner-only)')
    .addIntegerOption(o => o.setName('limit').setDescription('Max players (2-16)').setMinValue(2).setMaxValue(16))
    .addIntegerOption(o => o.setName('join_seconds').setDescription('Lobby time in seconds (10-120)').setMinValue(10).setMaxValue(120))
    .addIntegerOption(o => o.setName('best_of').setDescription('Odd number: 3/5/7').setChoices({name:'3',value:3},{name:'5',value:5},{name:'7',value:7}))
    .addStringOption(o =>
      o.setName('style').setDescription('Commentary vibe')
       .addChoices({name:'clean',value:'clean'},{name:'motivator',value:'motivator'},{name:'villain',value:'villain'},{name:'degen',value:'degen'})
    ),
  async execute(interaction) {
    if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: '🔒 Owner-only.', ephemeral: true });
    }
    const limit = interaction.options.getInteger('limit') ?? 8;
    const joinSeconds = interaction.options.getInteger('join_seconds') ?? 30;
    const bestOf = interaction.options.getInteger('best_of') ?? 3;
    const style = (interaction.options.getString('style') || '').toLowerCase() || 'motivator';

    await interaction.reply({ content: '🧩 Setting up lobby…', ephemeral: true });

    const hostMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!hostMember) return interaction.followUp({ content: 'Could not fetch host.', ephemeral: true });

    const players = await openLobby({
      channel: interaction.channel,
      hostMember,
      title: '🔔 Rumble Lobby',
      limit,
      joinSeconds
    });

    if (players.length < 2) {
      return interaction.followUp({ content: 'Lobby ended without enough players.', ephemeral: true });
    }

    await interaction.followUp({ content: `🎮 Starting bracket with **${players.length}** players…`, ephemeral: false });

    await runBracket({
      channel: interaction.channel,
      hostMessage: null,            // optional; bracket runs matches sequentially in channel (each match may thread per your ENV)
      players,
      bestOf,
      style,
      guildName: interaction.guild?.name || 'this server'
    });
  }
};

