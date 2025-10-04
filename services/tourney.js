// services/tourney.js
const { runRumbleDisplay } = require('./battleRumble');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function runBracket({
  channel,
  players,
  bestOf = 3,
  style = 'motivator',
  guildName = 'this server'
}) {
  if (!players || players.length < 2) {
    await channel.send('❌ Need at least 2 players.');
    return null;
  }

  let alive = shuffle(players);
  let roundNum = 1;

  while (alive.length > 1) {
    const pairs = [];
    for (let i = 0; i < alive.length; i += 2) {
      if (i + 1 < alive.length) pairs.push([alive[i], alive[i + 1]]);
      else pairs.push([alive[i], null]); // bye
    }

    await channel.send(`**🏁 Tournament Round ${roundNum}** — ${pairs.length} match${pairs.length > 1 ? 'es' : ''}.`);

    const nextAlive = [];
    for (const [A, B] of pairs) {
      if (!B) {
        await channel.send(`✅ **${A.displayName || A.user?.username || 'Player'}** advances by bye.`);
        nextAlive.push(A);
        continue;
      }

      const { champion } = await runRumbleDisplay({
        channel,
        baseMessage: null,
        challenger: A,
        opponent: B,
        bestOf,
        style,
        guildName
      });
      nextAlive.push(champion);
      await new Promise(r => setTimeout(r, 1800 + Math.floor(Math.random() * 900)));
    }

    alive = nextAlive;
    roundNum++;
    if (alive.length > 1) {
      await channel.send(`— **${alive.length}** remain. Preparing next round…`);
      await new Promise(r => setTimeout(r, 2500 + Math.floor(Math.random() * 1200)));
    }
  }

  const champion = alive[0];
  await channel.send(`🏆 **Champion:** ${champion.displayName || champion.user?.username || 'Winner'}`);
  return champion;
}

module.exports = { runBracket };

