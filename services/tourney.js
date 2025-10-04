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

function buildBracket(players) {
  const list = shuffle(players);
  const rounds = [];
  let round = list;
  while (round.length > 1) {
    const pairs = [];
    for (let i = 0; i < round.length; i += 2) {
      if (i + 1 < round.length) pairs.push([round[i], round[i + 1]]);
      else pairs.push([round[i], null]); // bye
    }
    rounds.push(pairs);
    // winners of next round are unknown yet; computed while running
    round = new Array(Math.ceil(round.length / 2)).fill(null);
  }
  return rounds; // structure only; we resolve winners on the fly
}

async function runBracket({
  channel,
  hostMessage = null,       // base message to thread off, if desired
  players,                  // array of GuildMembers
  bestOf = 3,
  style = 'motivator',
  guildName = 'this server'
}) {
  if (!players || players.length < 2) {
    await channel.send('❌ Need at least 2 players.');
    return null;
  }

  let alive = players.slice();
  let roundNum = 1;

  while (alive.length > 1) {
    const pairs = [];
    for (let i = 0; i < alive.length; i += 2) {
      if (i + 1 < alive.length) pairs.push([alive[i], alive[i + 1]]);
      else pairs.push([alive[i], null]);
    }

    await channel.send(`**🏁 Tournament Round ${roundNum}** — ${pairs.length} match${pairs.length > 1 ? 'es' : ''}.`);

    const nextAlive = [];
    for (const [A, B] of pairs) {
      if (!B) {
        // bye
        await channel.send(`✅ **${A.displayName || A.user?.username || 'Player'}** advances by bye.`);
        nextAlive.push(A);
        continue;
      }
      // Play 1v1 rumble using your existing engine
      const { sim, champion } = await runRumbleDisplay({
        channel,
        baseMessage: hostMessage, // ok if null
        challenger: A,
        opponent: B,
        bestOf,
        style,
        guildName
      });
      nextAlive.push(champion);
      // short breather between matches
      await new Promise(r => setTimeout(r, 1800 + Math.floor(Math.random() * 600)));
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
