// services/battleRumble.js
const { simulateBattle, aiCommentary, makeBar, clampBestOf } = require('./battleEngine');

const USE_THREAD = /^true$/i.test(process.env.BATTLE_USE_THREAD || 'true');
const THREAD_NAME = (process.env.BATTLE_THREAD_NAME || 'Rumble Royale').trim();
const ROUND_DELAY = Math.max(400, Number(process.env.BATTLE_ROUND_DELAY_MS || 1800));
const INTRO_DELAY = Math.max(200, Number(process.env.BATTLE_INTRO_DELAY_MS || 800));

function colorFor(style) {
  return style === 'villain' ? 0x8b0000
       : style === 'degen'   ? 0xe67e22
       : style === 'clean'   ? 0x3498db
       : 0x9b59b6;
}

async function runRumbleDisplay({
  channel,            // TextChannel to post in
  baseMessage,        // Message to start thread from (optional)
  challenger,
  opponent,
  bestOf = 3,
  style = 'motivator',
  guildName = 'this server'
}) {
  bestOf = clampBestOf(bestOf);
  const sim = simulateBattle({ challenger, opponent, bestOf, style });
  const title = `⚔️ Rumble: ${challenger.displayName || challenger.username} vs ${opponent.displayName || opponent.username}`;

  // 1) Intro post (create a thread if configured & permitted)
  let target = channel;
  let introMsg;
  try {
    if (USE_THREAD) {
      // Either start from the base message, or create an intro then thread
      if (baseMessage?.startThread) {
        const thread = await baseMessage.startThread({
          name: `${THREAD_NAME}: ${challenger.displayName || challenger.username} vs ${opponent.displayName || opponent.username}`,
          autoArchiveDuration: 60
        });
        target = thread;
      } else {
        introMsg = await channel.send({
          embeds: [{
            color: colorFor(style),
            title,
            description: `**Best of ${sim.bestOf}**\nPreparing the arena…`,
          }]
        });
        const thread = await introMsg.startThread({
          name: `${THREAD_NAME}: ${challenger.displayName || challenger.username} vs ${opponent.displayName || opponent.username}`,
          autoArchiveDuration: 60
        });
        target = thread;
      }
    } else if (!introMsg) {
      introMsg = await channel.send({
        embeds: [{
          color: colorFor(style),
          title,
          description: `**Best of ${sim.bestOf}**\nPreparing the arena…`,
        }]
      });
    }
  } catch {
    // Fallback: no thread perms
    if (!introMsg) {
      introMsg = await channel.send({
        embeds: [{
          color: colorFor(style),
          title,
          description: `**Best of ${sim.bestOf}**\nPreparing the arena…`,
        }]
      });
    }
    target = channel;
  }

  // small dramatic pause
  await new Promise(r => setTimeout(r, INTRO_DELAY));

  // 2) Round-by-round posts
  for (let i = 0; i < sim.rounds.length; i++) {
    const r = sim.rounds[i];
    const bar = makeBar(r.a, r.b, sim.bestOf);
    const embed = {
      color: colorFor(style),
      title: `Round ${i+1}`,
      description:
        `**${r.winner}** beats **${r.loser}**\n\n${bar}\n\n${r.text}`,
      footer: { text: `Style: ${style}` }
    };
    await target.send({ embeds: [embed] });
    if (i < sim.rounds.length - 1) {
      await new Promise(r => setTimeout(r, ROUND_DELAY));
    }
  }

  // 3) Finale
  const champion = sim.a > sim.b ? challenger : opponent;
  const runnerUp = sim.a > sim.b ? opponent  : challenger;
  const finalBar = makeBar(sim.a, sim.b, sim.bestOf);

  let cast = null;
  try {
    cast = await aiCommentary({
      winner: champion.displayName || champion.username,
      loser:  runnerUp.displayName || runnerUp.username,
      rounds: sim.rounds,
      style,
      guildName
    });
  } catch {}

  const finalEmbed = {
    color: colorFor(style),
    title: `🏆 Final: ${(champion.displayName || champion.username)} wins ${sim.a}-${sim.b}!`,
    description: `${finalBar}`,
    thumbnail: { url: champion.displayAvatarURL?.() || champion.avatarURL?.() || null },
    footer: { text: `Best of ${sim.bestOf} • Style: ${style}` },
  };
  if (cast) finalEmbed.fields = [{ name: '🎙️ Commentary', value: cast }];

  await target.send({ embeds: [finalEmbed] });

  // Link back in intro (if not threaded)
  if (introMsg && !USE_THREAD) {
    await introMsg.edit({
      embeds: [{
        color: colorFor(style),
        title,
        description: `**Best of ${sim.bestOf}**\nFight complete — winner: ${(champion.displayName || champion.username)} (${sim.a}-${sim.b}).`
      }]
    }).catch(() => {});
  }

  return { sim, champion };
}

module.exports = { runRumbleDisplay };
