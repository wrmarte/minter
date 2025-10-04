// listeners/rumblePrefix.js
const { runBracket } = require('../services/tourney');

const PREFIX = (process.env.RUMBLE_PREFIX || '!rumble').trim().toLowerCase();
const OWNER_ID = (process.env.BOT_OWNER_ID || '').trim();

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const txt = (message.content || '').trim();
    if (!txt.toLowerCase().startsWith(PREFIX)) return;

    if (!OWNER_ID || message.author.id !== OWNER_ID) {
      return message.reply('🔒 This command is currently owner-only.');
    }

    // Parse: !rumble @a @b @c … [best_of?] [style?]
    const mentions = [...message.mentions.users.values()];
    if (mentions.length < 2) {
      return message.reply('Usage: `!rumble @a @b @c [best_of] [style]` (need ≥2 mentions).');
    }

    const args = txt.slice(PREFIX.length).trim().split(/\s+/).filter(t => !t.startsWith('<@')); // strip mention tokens
    let bestOf = 3, style;
    for (const a of args) {
      if (/^\d+$/.test(a)) bestOf = Number(a);
      if (/^(clean|motivator|villain|degen)$/i.test(a)) style = a.toLowerCase();
    }
    bestOf = [3,5,7].includes(bestOf) ? bestOf : 3;
    style = style || 'motivator';

    const members = await Promise.all(
      mentions.map(u => message.guild.members.fetch(u.id).catch(() => null))
    );
    const players = members.filter(Boolean);
    if (players.length < 2) return message.reply('Not enough valid members fetched.');

    await message.reply(`🎮 Starting bracket with **${players.length}** players…`);

    try {
      await runBracket({
        channel: message.channel,
        hostMessage: null,
        players,
        bestOf,
        style,
        guildName: message.guild?.name || 'this server'
      });
    } catch (e) {
      console.error('rumble bracket error:', e);
      await message.channel.send('⚠️ Bracket crashed while running.');
    }
  });
};


