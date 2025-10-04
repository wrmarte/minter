// services/battleRumble.js
const { simulateBattle, aiCommentary, makeBar, clampBestOf } = require('./battleEngine');

/** ================== Config ================== */
const USE_THREAD   = /^true$/i.test(process.env.BATTLE_USE_THREAD || 'true');
const THREAD_NAME  = (process.env.BATTLE_THREAD_NAME || 'Rumble Royale').trim();

const INTRO_DELAY  = Math.max(200, Number(process.env.BATTLE_INTRO_DELAY_MS || 1200));
const STEP_DELAY   = Math.max(300, Number(process.env.BATTLE_STEP_DELAY_MS  || 2200));
const ROUND_DELAY  = Math.max(600, Number(process.env.BATTLE_ROUND_DELAY_MS || 4200));
const JITTER_MS    = Math.max(0,   Number(process.env.BATTLE_PACE_JITTER_MS || 900));

const SAFE_MODE         = !/^false$/i.test(process.env.BATTLE_SAFE_MODE || 'true'); // default true
const TAUNT_CHANCE      = clamp01(Number(process.env.BATTLE_TAUNT_CHANCE      || 0.60));
const COUNTER_CHANCE    = clamp01(Number(process.env.BATTLE_COUNTER_CHANCE    || 0.28));
const CRIT_CHANCE       = clamp01(Number(process.env.BATTLE_CRIT_CHANCE       || 0.18));

function clamp01(x){ x = Number(x); if (!isFinite(x)) return 0; return Math.min(1, Math.max(0, x)); }

/** ================== Utils ================== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (base) => base + Math.floor((Math.random() * 2 - 1) * JITTER_MS);

function colorFor(style) {
  return style === 'villain' ? 0x8b0000
       : style === 'degen'   ? 0xe67e22
       : style === 'clean'   ? 0x3498db
       : 0x9b59b6;
}

/** ================== Flavor banks ================== */
// Cartoon-safe arsenal (amped a bit when SAFE_MODE=false)
const WEAPONS_SAFE = [
  'foam bat', 'banana peel', 'rubber chicken', 'pool noodle',
  'pixel sword', 'glitch gauntlet', 'ban hammer', 'yo-yo', 'cardboard shield'
];
const WEAPONS_SPICY = [
  'steel chair', 'spiked bat (cosplay prop)', 'thunder gloves',
  'meteor hammer (training weight)'
];

const ACTIONS_SAFE = [
  'bonks', 'thwacks', 'boops', 'yeets', 'spin-kicks (stage move)',
  'shoulder-checks lightly', 'ankle-breaks (jukes)', 'jukes past'
];
const ACTIONS_SPICY = [
  'smashes', 'ground-slams', 'uppercuts (sparring form)', 'haymakers (pulled)'
];

const REACTIONS = [
  'dodges', 'parries', 'blocks', 'shrugs it off', 'stumbles', 'perfect guards'
];

const TAUNTS = {
  clean: [
    `Let’s keep it classy — {A} vs {B}, no salt.`,
    `Respectful duel. Breathe in, level up.`,
    `{A} nods. {B} nods back. It begins.`,
  ],
  motivator: [
    `{A}: "Clock in." {B}: "Clocked." 💪`,
    `{A} slaps the mat — "One clean rep at a time!"`,
    `{B}: "No fear. Only form." ⚡`,
  ],
  villain: [
    `{A}: "I’ll enjoy this." {B} smirks back.`,
    `{B} whispers: "Despair looks good on you."`,
    `Shadows lengthen… {A} and {B} step in.`
  ],
  degen: [
    `{A}: "Max leverage or bust." {B}: "Send it." 🚀`,
    `Limit orders? Nah — {A} market buys hands. 💥`,
    `{B}: "Giga-send only."`
  ]
};

const CRITS = [
  `{A} finds the pixel-perfect angle — **CRIT!** ⚡`,
  `Frame trap! {A} lands a **critical** read.`,
  `{A} charges a special — it lands! **Critical hit!**`
];

const COUNTERS = [
  `{B} counters with a snap reversal!`,
  `{B} reads it and flips momentum!`,
  `Clutch parry from {B}, instant punish!`
];

/** Build per-round micro-sequence without changing result logic.
 * winner/loser names passed in, but {attacker} may swap on counter chance.
 */
function buildRoundSequence({ A, B, style, rng = Math.random }) {
  // choose flavor pools
  const WEAPONS = SAFE_MODE ? WEAPONS_SAFE : WEAPONS_SAFE.concat(WEAPONS_SPICY);
  const VERBS   = SAFE_MODE ? ACTIONS_SAFE : ACTIONS_SAFE.concat(ACTIONS_SPICY);

  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  const seq = [];

  // (optional) pre-taunt
  if (rng() < TAUNT_CHANCE) {
    const t = pick(TAUNTS[style] || TAUNTS.motivator).replace('{A}', A).replace('{B}', B);
    seq.push({ type: 'taunt', content: `🗣️ ${t}` });
  }

  // main action (A attacks B)
  const w = pick(WEAPONS);
  const v = pick(VERBS);
  const action = `${A} grabs a ${w} and ${v} ${B}!`;
  seq.push({ type: 'action', content: `🥊 **${action}**` });

  // (optional) counter (B answers)
  let countered = false;
  if (rng() < COUNTER_CHANCE) {
    const c = pick(COUNTERS).replace('{B}', B);
    seq.push({ type: 'counter', content: `⚡ ${c}` });
    countered = true;
  } else {
    // otherwise B reacts
    const r = pick(REACTIONS);
    seq.push({ type: 'reaction', content: `🛡️ ${B} ${r}.` });
  }

  // (optional) crit on whoever has momentum (A unless countered)
  if (rng() < CRIT_CHANCE) {
    const critLine = pick(CRITS).replace('{A}', countered ? B : A);
    seq.push({ type: 'crit', content: `💥 ${critLine}` });
  }

  return seq;
}

/** ================== Rumble Runner (multi-post per round) ================== */
async function runRumbleDisplay({
  channel,            // TextChannel to post in
  baseMessage,        // Message to start the thread from (optional)
  challenger,
  opponent,
  bestOf = 3,
  style = 'motivator',
  guildName = 'this server'
}) {
  bestOf = clampBestOf(bestOf);
  const sim = simulateBattle({ challenger, opponent, bestOf, style });
  const Aname = challenger.displayName || challenger.username;
  const Bname = opponent.displayName   || opponent.username;
  const title = `⚔️ Rumble: ${Aname} vs ${Bname}`;

  // 1) Intro & optional thread
  let target = channel;
  let introMsg;
  try {
    if (USE_THREAD) {
      if (baseMessage?.startThread) {
        const thread = await baseMessage.startThread({
          name: `${THREAD_NAME}: ${Aname} vs ${Bname}`,
          autoArchiveDuration: 60
        });
        target = thread;
      } else {
        introMsg = await channel.send({
          embeds: [{
            color: colorFor(style),
            title,
            description: `**Best of ${sim.bestOf}**\nPreparing the arena…`
          }]
        });
        const thread = await introMsg.startThread({
          name: `${THREAD_NAME}: ${Aname} vs ${Bname}`,
          autoArchiveDuration: 60
        });
        target = thread;
      }
    } else if (!introMsg) {
      introMsg = await channel.send({
        embeds: [{
          color: colorFor(style),
          title,
          description: `**Best of ${sim.bestOf}**\nPreparing the arena…`
        }]
      });
    }
  } catch {
    // Fallback (no perms)
    if (!introMsg) {
      introMsg = await channel.send({
        embeds: [{
          color: colorFor(style),
          title,
          description: `**Best of ${sim.bestOf}**\nPreparing the arena…`
        }]
      });
    }
    target = channel;
  }

  // small dramatic pause before R1
  await sleep(jitter(INTRO_DELAY));

  // 2) Round-by-round micro posts
  for (let i = 0; i < sim.rounds.length; i++) {
    const r = sim.rounds[i];
    const bar = makeBar(r.a, r.b, sim.bestOf);

    // announce round start
    await target.send({ content: `🔔 **Round ${i + 1} — Fight!**` });
    await sleep(jitter(Math.max(400, STEP_DELAY / 2)));

    // generate micro-sequence (does not change the outcome)
    const seq = buildRoundSequence({ A: r.winner, B: r.loser, style });

    // stream the sequence
    for (const step of seq) {
      await target.send({ content: step.content });
      await sleep(jitter(STEP_DELAY));
    }

    // post the official round card with the score bar
    const embed = {
      color: colorFor(style),
      title: `Round ${i + 1} Result`,
      description: `**${r.winner}** beats **${r.loser}**\n\n${bar}\n\n${r.text}`,
      footer: { text: `Style: ${style}` }
    };
    await target.send({ embeds: [embed] });

    // pacing between rounds
    if (i < sim.rounds.length - 1) {
      await sleep(jitter(ROUND_DELAY));
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

  // If we didn’t thread, update the intro as a recap note
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
