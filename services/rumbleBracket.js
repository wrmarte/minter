// services/rumbleBracket.js
const { runRumbleDisplay } = require('./battleRumble');

const USE_THREAD  = /^true$/i.test(process.env.BATTLE_USE_THREAD || 'true');
const THREAD_NAME = (process.env.BATTLE_THREAD_NAME || 'Rumble Royale').trim();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitterMs = Math.max(0, Number(process.env.BATTLE_PACE_JITTER_MS || 1200));
const jitter = (base) => base + Math.floor((Math.random() * 2 - 1) * jitterMs);
const INTRO_DELAY = Math.max(300, Number(process.env.BATTLE_INTRO_DELAY_MS || 1400));

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

function nameOf(m) { return m.displayName || m.user?.username || 'Fighter'; }

function bracketRoundEmbed({ roundIdx, totalRounds, pairs }) {
  return {
    color: 0x5865F2,
    author: { name: 'Rumble Royale' },
    title: `🗺️ Bracket — Round ${roundIdx + 1}/${totalRounds}`,
    description: pairs.map(([a,b], i) =>
      b ? `**Match ${i+1}**: ${nameOf(a)} vs ${nameOf(b)}`
        : `**Match ${i+1}**: ${nameOf(a)} (bye)`
    ).join('\n')
  };
}

function finalBracketEmbed({ champion, pathSummary }) {
  const avatar = (typeof champion.displayAvatarURL === 'function')
    ? champion.displayAvatarURL() :
    (champion.user?.displayAvatarURL ? champion.user.displayAvatarURL() : null);
  return {
    color: 0x2ecc71,
    author: { name: 'Rumble Royale' },
    title: `🏆 Tournament Champion — ${nameOf(champion)}`,
    thumbnail: avatar ? { url: avatar } : undefined,
    description: pathSummary.join('\n')
  };
}

async function runBracketRumble({ channel, baseMessage, fighters, bestOf = 3, style = 'motivator', guildName = 'this server' }) {
  // Shuffle & pad to power-of-two with byes
  let pool = shuffle(fighters);
  const needed = nextPow2(pool.length);
  const byes = needed - pool.length;
  for (let i = 0; i < byes; i++) pool.push(null);

  // Optional: move into thread from seed message
  let target = channel;
  try {
    if (baseMessage && baseMessage.startThread && USE_THREAD) {
      const thread = await baseMessage.startThread({
        name: `${THREAD_NAME}: Bracket (${fighters.length})`,
        autoArchiveDuration: 60
      });
      target = thread;
    }
  } catch {}

  let roundIdx = 0;
  const totalRounds = Math.log2(needed);
  const path = new Map(); // winner -> [summary lines]

  while (pool.length > 1) {
    const nextPool = [];
    const pairs = [];
    for (let i = 0; i < pool.length; i += 2) {
      const a = pool[i];
      const b = pool[i + 1] || null;
      if (a && b) pairs.push([a, b]);
      else if (a && !b) pairs.push([a, null]);
    }

    await target.send({ embeds: [bracketRoundEmbed({ roundIdx, totalRounds, pairs })] });
    await sleep(jitter(INTRO_DELAY));

    for (const [a, b] of pairs) {
      if (a && !b) {
        nextPool.push(a);
        const line = `Bye → ${nameOf(a)} advances`;
        const list = path.get(a) || [];
        list.push(line);
        path.set(a, list);
        continue;
      }
      if (!a || !b) continue;

      // Seed a tiny "match incoming" and let battleRumble drive the cinematic
      const seed = await target.send({ content: `⚔️ **${nameOf(a)}** vs **${nameOf(b)}** — match incoming…` });
      const { sim, champion } = await runRumbleDisplay({
        channel: target,
        baseMessage: seed,
        challenger: a,
        opponent: b,
        bestOf,
        style,
        guildName
      });

      nextPool.push(champion);
      const loser = (champion.id === a.id) ? b : a;
      const line = `R${roundIdx+1}: ${nameOf(champion)} def. ${nameOf(loser)} (${sim.a}-${sim.b})`;
      const list = path.get(champion) || [];
      list.push(line);
      path.set(champion, list);
    }

    pool = nextPool;
    roundIdx++;
  }

  const champion = pool[0];
  const pathSummary = path.get(champion) || [];
  await target.send({ embeds: [finalBracketEmbed({ champion, pathSummary })] });
  return champion;
}

module.exports = { runBracketRumble };
