// services/rumbleRoyale.js
const { runRumbleDisplay } = require('./battleRumble');
const { clampBestOf } = require('./battleEngine');

const USE_THREAD  = /^true$/i.test(process.env.BATTLE_USE_THREAD || 'true');
const THREAD_NAME = (process.env.BATTLE_THREAD_NAME || 'Rumble Royale').trim();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const INTRO_DELAY = Math.max(300, Number(process.env.BATTLE_INTRO_DELAY_MS || 1400));
const ROUND_DELAY = Math.max(500, Number(process.env.BATTLE_ROUND_DELAY_MS || 5200));
const jitterMs    = Math.max(0, Number(process.env.BATTLE_PACE_JITTER_MS || 1200));
const jitter = (base) => base + Math.floor((Math.random() * 2 - 1) * jitterMs);

function nameOf(m) { return m.displayName || m.user?.username || 'Fighter'; }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function royaleIntroEmbed(count) {
  return {
    color: 0xff006e,
    author: { name: 'Rumble Royale' },
    title: `💥 Battle Royale Incoming (${count} fighters)`,
    description: `All combatants enter the arena. Random skirmishes will erupt until one stands.`
  };
}
function hazardEmbed(text) {
  return {
    color: 0xf1c40f,
    author: { name: 'Rumble Royale' },
    title: `⚠️ Arena Event`,
    description: text
  };
}
function championEmbed(champion) {
  const avatar = (typeof champion.displayAvatarURL === 'function')
    ? champion.displayAvatarURL()
    : (champion.user?.displayAvatarURL ? champion.user.displayAvatarURL() : null);
  return {
    color: 0x2ecc71,
    author: { name: 'Rumble Royale' },
    title: `🏆 Battle Royale Champion — ${nameOf(champion)}`,
    thumbnail: avatar ? { url: avatar } : undefined
  };
}

const HAZARDS = [
  'Fog machine overload — visibility drops!',
  'Spotlights strobe randomly — timing windows wobble!',
  'Floor tiles shift — footing is sus!',
  'Confetti cannons misfire — chaos in the air!',
  'Drone camera swoops too low — everyone ducks!'
];

async function runRoyaleRumble({ channel, baseMessage, fighters, style = 'motivator', guildName = 'this server' }) {
  // Optional thread
  let target = channel;
  try {
    if (baseMessage && baseMessage.startThread && USE_THREAD) {
      const thread = await baseMessage.startThread({
        name: `${THREAD_NAME}: Battle Royale (${fighters.length})`,
        autoArchiveDuration: 60
      });
      target = thread;
    }
  } catch {}

  // Intro
  const order = shuffle(fighters);
  await target.send({ embeds: [royaleIntroEmbed(order.length)] });
  await sleep(jitter(INTRO_DELAY));

  // Loop skirmishes until one remains
  const alive = order.slice();
  let round = 1;

  while (alive.length > 1) {
    // Random hazard sometimes (but not too often)
    if (Math.random() < 0.28) {
      await target.send({ embeds: [hazardEmbed(HAZARDS[Math.floor(Math.random() * HAZARDS.length)])] });
      await sleep(jitter(900));
    }

    // Pick two distinct fighters
    if (alive.length < 2) break;
    const i = Math.floor(Math.random() * alive.length);
    let j = Math.floor(Math.random() * alive.length);
    while (j === i) j = Math.floor(Math.random() * alive.length);

    const a = alive[i];
    const b = alive[j];

    // Post seed + run a quick best-of-1 cinematic using your engine
    const seed = await target.send({ content: `🔻 Skirmish ${round}: **${nameOf(a)}** vs **${nameOf(b)}** — first to strike takes it!` });
    const { sim, champion } = await runRumbleDisplay({
      channel: target,
      baseMessage: seed,
      challenger: a,
      opponent: b,
      bestOf: 1,                // fast duel
      style,
      guildName
    });

    // Eliminate loser
    const loser = (champion.id === a.id) ? b : a;
    const loserIdx = alive.findIndex(m => m.id === loser.id);
    if (loserIdx !== -1) alive.splice(loserIdx, 1);

    // Tiny breather between skirmishes
    round++;
    if (alive.length > 1) await sleep(jitter(ROUND_DELAY));
  }

  const champion = alive[0];
  if (champion) {
    await target.send({ embeds: [championEmbed(champion)] });
  } else {
    await target.send({ content: '🤖 Royale ended unexpectedly with no champion (edge case).' });
  }
  return champion;
}

module.exports = { runRoyaleRumble };
