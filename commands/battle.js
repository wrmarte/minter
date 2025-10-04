// commands/battle.js
const { SlashCommandBuilder } = require('discord.js');
const { ready } = require('../services/battleEngine');
const { runRumbleDisplay } = require('../services/battleRumble');

const OWNER_ID = (process.env.BOT_OWNER_ID || '').trim();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Rumble Royale: round-by-round battle (owner-only)')
    .addUserOption(o => o.setName('opponent').setDescription('Who are you battling?').setRequired(false))
    .addIntegerOption(o => o.setName('best_of').setDescription('Odd number: 3,5,7').setRequired(false))
    .addStringOption(o =>
      o.setName('style')
       .setDescription('Commentary vibe')
       .addChoices(
         { name: 'clean', value: 'clean' },
         { name: 'motivator', value: 'motivator' },
         { name: 'villain', value: 'villain' },
         { name: 'degen', value: 'degen' }
       )
       .setRequired(false)
    ),

  async execute(interaction) {
    if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: '🔒 This command is currently owner-only.', ephemeral: true });
    }
    if (!ready(`${interaction.guildId}:${interaction.user.id}`)) {
      return interaction.reply({ content: '⏳ Cooldown — give it a few seconds.', ephemeral: true });
    }

    const opponent = interaction.options.getUser('opponent') || interaction.client.user;
    const bestOf   = interaction.options.getInteger('best_of') || 3;
    const style    = (interaction.options.getString('style') || '').toLowerCase() || undefined;

    const guild = interaction.guild;
    const [challengerMember, opponentMember] = await Promise.all([
      guild.members.fetch(interaction.user.id).catch(() => ({ user: interaction.user })),
      guild.members.fetch(opponent.id).catch(() => ({ user: opponent }))
    ]);

    // Neutral placeholder (NOT "Rumble incoming"). This message will be edited by runRumbleDisplay.
    const starter = await interaction.reply({
      embeds: [{
        color: 0x9b59b6,
        title: '⚙️ Setting up the match…',
        description: `Preparing **${challengerMember.displayName || interaction.user.username}** vs **${opponentMember.displayName || opponent.username}**`
      }],
      fetchReply: true
    });

    await runRumbleDisplay({
      channel: interaction.channel,
      baseMessage: starter, // ensures only one "Rumble incoming…" appears
      challenger: challengerMember,
      opponent: opponentMember,
      bestOf,
      style,
      guildName: guild?.name || 'this server'
    });
  }
};

