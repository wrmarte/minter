// listeners/battlePrefix.js
const { ready } = require('../services/battleEngine');
const { runRumbleDisplay } = require('../services/battleRumble');

const PREFIX = (process.env.BATTLE_PREFIX || '!battle').trim().toLowerCase();

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const txt = (message.content || '').trim();
    if (!txt.toLowerCase().startsWith(PREFIX)) return;

    if (!ready(`${message.guild.id}:${message.author.id}`)) {
      return message.reply('⏳ Cooldown — give it a few seconds.');
    }

    // Parse: !battle [@opponent] [best_of?] [style?]
    const args = txt.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
    const opponent = message.mentions.users.first() || message.client.user;

    let bestOf = 3, style;
    for (const a of args) {
      if (/^\d+$/.test(a)) bestOf = Number(a);
      if (/^(clean|motivator|villain|degen)$/i.test(a)) style = a.toLowerCase();
    }

    const guild = message.guild;
    const [challengerMember, opponentMember] = await Promise.all([
      guild.members.fetch(message.author.id).catch(() => ({ user: message.author })),
      guild.members.fetch(opponent.id).catch(() => ({ user: opponent }))
    ]);

    // Intro message
    const introMsg = await message.reply({
      embeds: [{
        color: 0x9b59b6,
        title: '⚔️ Rumble incoming',
        description: `Setting up **${challengerMember.displayName || message.author.username}** vs **${opponentMember.displayName || opponent.username}**…`
      }]
    });

    try {
      await runRumbleDisplay({
        channel: message.channel,
        baseMessage: introMsg,
        challenger: challengerMember,
        opponent: opponentMember,
        bestOf,
        style,
        guildName: guild?.name || 'this server'
      });
    } catch (e) {
      console.error('battle rumble error:', e);
      await message.channel.send('⚠️ Rumble crashed while loading. Try again.');
    }
  });
};

