// commands/battle.js
const { SlashCommandBuilder } = require('discord.js');
const { runBattle, ready, clampBestOf } = require('../services/battleEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Pit two warriors in a best-of showdown')
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

    // Fetch full GuildMember for displayName/avatar
    const guild = interaction.guild;
    const [challengerMember, opponentMember] = await Promise.all([
      guild.members.fetch(user.id).catch(() => ({ user })),
      guild.members.fetch(opponent.id).catch(() => ({ user: opponent }))
    ]);

    await interaction.deferReply();

    const { embed } = await runBattle({
      challenger: challengerMember,
      opponent: opponentMember,
      bestOf,
      style,
      guildName: guild?.name || 'this server'
    });

    return interaction.editReply({ embeds: [embed] });
  }
};
