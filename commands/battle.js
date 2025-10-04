// commands/battle.js
const { SlashCommandBuilder } = require('discord.js');
const { ready } = require('../services/battleEngine');
const { runRumbleDisplay } = require('../services/battleRumble');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Pit two warriors in a best-of showdown (Rumble Royale style)')
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
    const user = interaction.user;
    if (!ready(`${interaction.guildId}:${user.id}`)) {
      return interaction.reply({ content: '⏳ Cooldown — give it a few seconds.', ephemeral: true });
    }

    const opponent = interaction.options.getUser('opponent') || interaction.client.user;
    const bestOf   = interaction.options.getInteger('best_of') || 3;
    const style    = (interaction.options.getString('style') || '').toLowerCase() || undefined;

    // Fetch members for displayName/avatar
    const guild = interaction.guild;
    const [challengerMember, opponentMember] = await Promise.all([
      guild.members.fetch(user.id).catch(() => ({ user })),
      guild.members.fetch(opponent.id).catch(() => ({ user: opponent }))
    ]);

    // Post intro in channel first, then thread from that message if configured
    const intro = await interaction.reply({
      embeds: [{
        color: 0x9b59b6,
        title: `⚔️ Rumble incoming`,
        description: `Setting up **${challengerMember.displayName || user.username}** vs **${opponentMember.displayName || opponent.username}**…`
      }],
      fetchReply: true
    });

    await runRumbleDisplay({
      channel: interaction.channel,
      baseMessage: intro,
      challenger: challengerMember,
      opponent: opponentMember,
      bestOf,
      style,
      guildName: guild?.name || 'this server'
    });
  }
};
