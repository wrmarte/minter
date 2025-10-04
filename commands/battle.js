// commands/battle.js
const { SlashCommandBuilder } = require('discord.js');
// Cooldown helper (optional): if you have this in your engine, keep it; otherwise remove the 'ready' check.
const { ready } = require('../services/battleEngine');
const { runRumbleDisplay } = require('../services/battleRumble');

function clampBestOf(n) {
  // Accepts 1,3,5,7... (defaults to 3). If even is provided, bump to next odd.
  n = Number(n) || 3;
  if (n < 1) n = 1;
  if (n % 2 === 0) n += 1;
  if (n > 9) n = 9; // sane cap
  return n;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Start a 1v1 battle (round-by-round, no lobby)')
    .addUserOption(o =>
      o.setName('opponent')
       .setDescription('Who are you battling?')
       .setRequired(false)
    )
    .addIntegerOption(o =>
      o.setName('best_of')
       .setDescription('Odd number: 3,5,7,9 (defaults to 3)')
       .setRequired(false)
    )
    .addStringOption(o =>
      o.setName('style')
       .setDescription('Commentary vibe')
       .addChoices(
         { name: 'clean',     value: 'clean' },
         { name: 'motivator', value: 'motivator' },
         { name: 'villain',   value: 'villain' },
         { name: 'degen',     value: 'degen' }
       )
       .setRequired(false)
    ),

  async execute(interaction) {
    try {
      // Optional cooldown gate if your engine exposes it
      if (typeof ready === 'function' && !ready(`${interaction.guildId}:${interaction.user.id}`)) {
        return interaction.reply({ content: '⏳ Cooldown — give it a few seconds.', ephemeral: true });
      }

      const opponentUser = interaction.options.getUser('opponent') || interaction.client.user;
      const bestOf = clampBestOf(interaction.options.getInteger('best_of') ?? 3);
      const style  = (interaction.options.getString('style') || 'motivator').toLowerCase();

      const guild = interaction.guild;
      const [challengerMember, opponentMember] = await Promise.all([
        guild.members.fetch(interaction.user.id).catch(() => ({ user: interaction.user })),
        guild.members.fetch(opponentUser.id).catch(() => ({ user: opponentUser }))
      ]);

      // Single neutral placeholder (will be edited into “Rumble incoming…” by the display)
      const starter = await interaction.reply({
        embeds: [{
          color: 0x9b59b6,
          title: '⚙️ Setting up the match…',
          description: `Preparing **${challengerMember.displayName || interaction.user.username}** vs **${opponentMember.displayName || opponentUser.username}**`
        }],
        fetchReply: true
      });

      // Pure 1v1 — NO lobby, NO bracket
      await runRumbleDisplay({
        channel: interaction.channel,
        baseMessage: starter,               // ensures only one intro message
        challenger: challengerMember,
        opponent: opponentMember,
        bestOf,
        style,
        guildName: guild?.name || 'this server'
      });
    } catch (e) {
      console.error('❌ Error in /battle:', e);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Something went wrong starting the battle.', ephemeral: true });
        } else {
          await interaction.followUp({ content: 'Something went wrong starting the battle.', ephemeral: true });
        }
      } catch {}
    }
  }
};
