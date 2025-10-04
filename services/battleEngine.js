// services/battleEngine.js
const fetch = require('node-fetch');

const BATTLE_COOLDOWN_MS = Math.max(5000, Number(process.env.BATTLE_COOLDOWN_MS || 12000));
const BATTLE_MAX_BEST_OF = Math.max(3, Math.min(7, Number(process.env.BATTLE_MAX_BEST_OF || 7)));
const DEFAULT_STYLE = (process.env.BATTLE_STYLE_DEFAULT || 'motivator').trim().toLowerCase();

const cooldown = new Map(); // key -> ts

function ready(id) {
  const last = cooldown.get(id) || 0;
  const ok = Date.now() - last >= BATTLE_COOLDOWN_MS;
  if (ok) cooldown.set(id, Date.now());
  return ok;
}

function seededRng(seed) {
  let x = 0;
  for (let i = 0; i < seed.length; i++) x = (x ^ seed.charCodeAt(i)) >>> 0;
  if (x === 0) x = 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return (x >>> 0) / 0x100000000;
  };
}

function clampBestOf(n) {
  let v = Number(n) || 3;
  v = Math.max(3, Math.min(BATTLE_MAX_BEST_OF, v));
  if (v % 2 === 0) v -= 1;
  return v;
}

function roundNarration(winnerName, loserName, style) {
  const bank = {
    clean: [
      `{W} edges out {L}.`,
      `{W} takes the round.`,
      `{W} outplays {L}.`,
      `{W} lands the decisive hit.`,
    ],
    motivator: [
      `{W} flexes form — clean rep on {L}! 💪`,
      `{W} keeps momentum — {L} wobbles. ⚡`,
      `{W} stays locked in. {L} needs a reset. 🎯`,
      `Pressure set. {W} racks another W. 🏋️`,
    ],
    villain: [
      `{W} toys with {L}… delightful. 🦹`,
      `{W} carves a path; {L} watches darkness close in.`,
      `A perfect sting — {W} leaves {L} reeling.`,
      `{W} whispers checkmate; {L} didn’t see it.`,
    ],
    degen: [
      `{W} sends it — {L} coping. 🚀`,
      `{W} hits max leverage; {L} gets liquidated. 💥`,
      `Full send. {W} prints, {L} hints. 💸`,
      `{W} cooks; {L} booked. 🍳`,
    ]
  }[style] || roundNarration('', '', 'motivator');

  const t = bank[Math.floor(Math.random() * bank.length)];
  return t.replace('{W}', winnerName).replace('{L}', loserName);
}

function makeBar(a, b, total) {
  const wins = a + b;
  const len = Math.max(total, wins); // ensure visibility
  const green = Math.max(0, a);
  const red   = Math.max(0, b);
  const empty = Math.max(0, len - green - red);
  return '🟩'.repeat(green) + '🟥'.repeat(red) + '⬛'.repeat(empty);
}

async function aiCommentary({ winner, loser, rounds, style, guildName }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;

  const system =
    `You are a hype caster for Discord battles in server ${guildName}.` +
    ` Give ONE short banger line (≤140 chars), matching style="${style}".` +
    ` Be playful, no slurs.`;

  const summary = rounds.map((r, i) => `R${i+1}:${r.winner} over ${r.loser}`).join(' | ');
  const user = `Final: ${winner} defeats ${loser}. Rounds: ${summary}. One-line cast:`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: (process.env.GROQ_MODEL || '').trim() || 'llama-3.1-8b-instant',
        temperature: 0.9,
        max_tokens: 80,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    const txt = await res.text();
    const json = JSON.parse(txt);
    const line = json?.choices?.[0]?.message?.content?.trim();
    return line?.slice(0, 200) || null;
  } catch {
    return null;
  }
}

/** NEW: pure simulation for round-by-round displays */
function simulateBattle({ challenger, opponent, bestOf, style = DEFAULT_STYLE }) {
  bestOf = clampBestOf(bestOf);
  const seed = `${challenger.id}:${opponent.id}:${Date.now()}:${bestOf}:${style}`;
  const rng = seededRng(seed);

  let a = 0, b = 0;
  const rounds = [];
  const need = Math.ceil(bestOf / 2);

  while (a < need && b < need) {
    const roll = rng();
    const winner = roll < 0.5 ? challenger : opponent;
    const loser  = (winner === challenger) ? opponent : challenger;

    if (winner === challenger) a++; else b++;

    rounds.push({
      winner: winner.displayName || winner.username || 'A',
      loser:  loser.displayName  || loser.username  || 'B',
      a, b,                       // running score after this round
      text: roundNarration(
        winner.displayName || winner.username,
        loser.displayName  || loser.username,
        style
      )
    });
  }

  const champion = a > b ? challenger : opponent;
  const runnerUp = a > b ? opponent  : challenger;

  return {
    rounds,
    a, b,
    bestOf,
    style,
    champion,
    runnerUp,
  };
}

/** Existing final embed builder (unchanged external signature) */
async function runBattle({ challenger, opponent, bestOf, style = DEFAULT_STYLE, guildName }) {
  const sim = simulateBattle({ challenger, opponent, bestOf, style });

  const bar = makeBar(sim.a, sim.b, sim.bestOf);
  const embed = {
    color: style === 'villain' ? 0x8b0000 : style === 'degen' ? 0xe67e22 : style === 'clean' ? 0x3498db : 0x9b59b6,
    title: `⚔️ Battle: ${challenger.displayName || challenger.username} vs ${opponent.displayName || opponent.username}`,
    description:
      `**Best of ${sim.bestOf}**\n` +
      `**${(sim.champion.displayName || sim.champion.username)} wins ${sim.a}-${sim.b}!**\n\n` +
      `${bar}\n` +
      sim.rounds.map((r, i) => `**R${i+1}.** ${r.text}`).join('\n'),
    thumbnail: { url: sim.champion.displayAvatarURL?.() || sim.champion.avatarURL?.() || null },
    footer: { text: `Style: ${style}` }
  };

  const cast = await aiCommentary({
    winner: sim.champion.displayName || sim.champion.username,
    loser:  sim.runnerUp.displayName || sim.runnerUp.username,
    rounds: sim.rounds,
    style,
    guildName
  });
  if (cast) embed.fields = [{ name: '🎙️ Commentary', value: cast }];

  return { embed, winner: sim.champion, score: `${sim.a}-${sim.b}`, sim };
}

module.exports = {
  ready,
  clampBestOf,
  simulateBattle,   // NEW export
  runBattle,        // existing
  aiCommentary,     // export for display helper
  // helper so others can draw bars mid-fight
  makeBar
};
