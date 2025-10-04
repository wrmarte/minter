// services/battleRumble.js
const { simulateBattle, aiCommentary, makeBar, clampBestOf } = require('./battleEngine');

/* ========================== Config ========================== */
const USE_THREAD   = /^true$/i.test(process.env.BATTLE_USE_THREAD || 'true');
const THREAD_NAME  = (process.env.BATTLE_THREAD_NAME || 'Rumble Royale').trim();

const INTRO_DELAY  = Math.max(200, Number(process.env.BATTLE_INTRO_DELAY_MS || 1400));
const STEP_DELAY   = Math.max(300, Number(process.env.BATTLE_STEP_DELAY_MS  || 2400));
const ROUND_DELAY  = Math.max(600, Number(process.env.BATTLE_ROUND_DELAY_MS || 5200));
const JITTER_MS    = Math.max(0,   Number(process.env.BATTLE_PACE_JITTER_MS || 1200));

const SAFE_MODE    = !/^false$/i.test(process.env.BATTLE_SAFE_MODE || 'true');
const ANNOUNCER    = (process.env.BATTLE_ANNOUNCER || 'normal').trim().toLowerCase();

const TAUNT_CHANCE   = clamp01(Number(process.env.BATTLE_TAUNT_CHANCE   || 0.65));
const COUNTER_CHANCE = clamp01(Number(process.env.BATTLE_COUNTER_CHANCE || 0.30));
const CRIT_CHANCE    = clamp01(Number(process.env.BATTLE_CRIT_CHANCE    || 0.22));
const STUN_CHANCE    = clamp01(Number(process.env.BATTLE_STUN_CHANCE    || 0.22));
const EVENTS_CHANCE  = clamp01(Number(process.env.BATTLE_EVENTS_CHANCE  || 0.35));
const CROWD_CHANCE   = clamp01(Number(process.env.BATTLE_CROWD_REACT_CHANCE || 0.40));
const HAZARD_CHANCE  = clamp01(Number(process.env.BATTLE_HAZARD_CHANCE  || 0.18));
const POWERUP_CHANCE = clamp01(Number(process.env.BATTLE_POWERUP_CHANCE || 0.22));
const COMBO_MAX      = Math.max(1, Math.min(5, Number(process.env.BATTLE_COMBO_MAX || 3)));
const SFX_ON         = !/^false$/i.test(process.env.BATTLE_SFX || 'true');

function clamp01(x){ x = Number(x); if (!isFinite(x)) return 0; return Math.min(1, Math.max(0, x)); }

/* ========================== Utils ========================== */
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (base) => base + Math.floor((Math.random() * 2 - 1) * JITTER_MS);
const pick   = (arr) => arr[Math.floor(Math.random() * arr.length)];
const exists = (s) => typeof s === 'string' && s.trim().length > 0;

function colorFor(style) {
  return style === 'villain' ? 0x8b0000
       : style === 'degen'   ? 0xe67e22
       : style === 'clean'   ? 0x3498db
       : 0x9b59b6;
}

function parseCsvEnv(s) {
  if (!exists(s)) return null;
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

/* ========================== Flavor ========================== */
// Environments
const ENV_BUILTIN = [
  { name: 'Neon Rooftop', intro: 'City lights hum below; the wind carries hype.' },
  { name: 'Underground Dojo', intro: 'Paper walls, sand floor, respectful echoes.' },
  { name: 'Pixel Coliseum', intro: 'Crowd rendered at 60fps — their chant buffers in.' },
  { name: 'Synthwave Boardwalk', intro: 'Waves slap the pier; a neon crane games watches.' },
  { name: 'Server Room Arena', intro: 'Fans whirr; LEDs blink like judging eyes.' },
];
const ENV_OVERRIDE = parseCsvEnv(process.env.BATTLE_ENVIRONMENTS);
const ENVIRONMENTS = ENV_OVERRIDE?.map(n => ({ name: n, intro: 'The air crackles — energy rises.' })) || ENV_BUILTIN;

// SFX bursts
const SFX = [
  '💥', '⚡', '🔥', '✨', '💫', '🫨', '🌪️', '🎯', '🧨', '🥁', '📣', '🔊'
];
const SFX_STRING = () => SFX_ON ? ' ' + Array.from({length: 2 + Math.floor(Math.random()*3)}, () => pick(SFX)).join('') : '';

// Style-based taunts
const TAUNTS = {
  clean: [
    `Gloves up. Form sharp. {A} and {B} nod.`,
    `{A}: "Best self only." {B}: "Always."`,
    `Respect. Skill. Timing. Go.`
  ],
  motivator: [
    `{A}: "Clock in." {B}: "Clocked." 💪`,
    `{B}: "We grind clean — no excuse." ⚡`,
    `Breathe. Focus. Execute.`
  ],
  villain: [
    `{A}: "I’ll savor this." {B} smiles thinly.`,
    `Shadows coil as {A} and {B} step forward.`,
    `{B}: "Hope is a habit I removed."`
  ],
  degen: [
    `{A}: "Max leverage." {B}: "Full send." 🚀`,
    `Slippage set to chaos — {A} vs {B}.`,
    `{B}: "Prints only. No stops."`
  ]
};

// Weapons / actions vary by style & safe mode
const WEAPONS_SAFE = [
  'foam bat','rubber chicken','pool noodle','pixel sword','ban hammer',
  'yo-yo','cardboard shield','training mitts','toy bo staff'
];
const WEAPONS_SPICY = [
  'steel chair (cosplay prop)','spiked bat (prop)','thunder gloves','meteor hammer (training)'
];
const ACTIONS_SAFE = [
  'bonks','thwacks','boops','yeets','spin-kicks (stage move)','jukes','shoulder-bumps',
  'cartwheel feints','sweeps (light)'
];
const ACTIONS_SPICY = [
  'smashes','ground-slams','uppercuts (sparring form)','haymakers (pulled)'
];

// Reactions / counters / crits
const REACTIONS = ['dodges','parries','blocks','shrugs it off','stumbles','perfect guards'];
const COUNTERS = [
  `{B} snaps a reversal!`,
  `{B} reads it and flips momentum!`,
  `Clutch parry from {B}, instant punish!`
];
const CRITS = [
  `{A} finds the pixel-perfect angle — **CRIT!**`,
  `Frame trap! {A} lands a **critical** read!`,
  `{A} channels a special — it hits! **Critical!**`
];

// Announcer personas
const ANNOUNCER_BANK = {
  normal: [
    `Commentary: textbook spacing — beautiful footwork.`,
    `Commentary: momentum swings, crowd on edge.`,
    `Commentary: timing windows are razor thin.`
  ],
  villain: [
    `Announcer: it’s delicious when hope cracks.`,
    `Announcer: watch the light drain — exquisite.`,
    `Announcer: despair taught them discipline.`
  ],
  degen: [
    `Announcer: leverage UP — liquidation candles in sight.`,
    `Announcer: full send only — printers humming.`,
    `Announcer: alpha drop mid-fight, cope rising.`
  ]
};

// Crowd chatter / events
const CROWD = [
  'Crowd roars!',
  'Someone rings a cowbell.',
  'A vuvuzela bleats in 8-bit.',
  'Chants ripple through the stands.',
  'Camera flashes pop!'
];
const HAZARDS = [
  'Floor tiles shift suddenly!',
  'A rogue shopping cart drifts across the arena!',
  'Fog machine overperforms, visibility drops!',
  'Neon sign flickers; shadows dance unpredictably!',
  'A stray confetti cannon fires!'
];
const POWERUPS = [
  '{X} picks up a glowing orb — speed up!',
  '{X} grabs a pixel heart — stamina bump!',
  '{X} equips glitch boots — dash unlocked!',
  '{X} finds a shield bubble — temporary guard!'
];

/* ========================== Round builders ========================== */
function buildTaunt(style, A, B) {
  const bank = TAUNTS[style] || TAUNTS.motivator;
  return `🗣️ ${pick(bank).replace('{A}', A).replace('{B}', B)}`;
}

function buildAction(A, B) {
  const WEAP = SAFE_MODE ? WEAPONS_SAFE : WEAPONS_SAFE.concat(WEAPONS_SPICY);
  const ACT  = SAFE_MODE ? ACTIONS_SAFE  : ACTIONS_SAFE.concat(ACTIONS_SPICY);
  const w = pick(WEAP); const v = pick(ACT);
  return `🥊 **${A} grabs a ${w} and ${v} ${B}!**${SFX_STRING()}`;
}

function buildReaction(B) {
  return `🛡️ ${B} ${pick(REACTIONS)}.${SFX_STRING()}`;
}

function buildCounter(B) {
  return `⚡ ${pick(COUNTERS).replace('{B}', B)}${SFX_STRING()}`;
}

function buildCrit(attacker) {
  return `💥 ${pick(CRITS).replace('{A}', attacker)}${SFX_STRING()}`;
}

function randomEvent(A, B) {
  // pick environment events: hazard or powerup or crowd
  const roll = Math.random();
  if (roll < HAZARD_CHANCE) {
    return `⚠️ ${pick(HAZARDS)}`;
  } else if (roll < HAZARD_CHANCE + POWERUP_CHANCE) {
    const who = Math.random() < 0.5 ? A : B;
    return `🔸 ${pick(POWERUPS).replace('{X}', who)}${SFX_STRING()}`;
  } else if (roll < HAZARD_CHANCE + POWERUP_CHANCE + CROWD_CHANCE) {
    return `📣 ${pick(CROWD)}`;
  }
  return null;
}

function buildAnnouncer(style) {
  if (ANNOUNCER === 'none') return null;
  const persona = ANNOUNCER_BANK[ANNOUNCER] || ANNOUNCER_BANK.normal;
  const line = pick(persona);
  // If user chose a style and persona differs, occasionally bias with style:
  if (Math.random() < 0.35 && ANNOUNCER_BANK[style]) {
    return `🎙️ ${pick(ANNOUNCER_BANK[style])}`;
  }
  return `🎙️ ${line}`;
}

/** Build per-round micro-sequence.
 * winner=r.winner (A), loser=r.loser (B) — but sequence can counter/crit without changing outcome.
 */
function buildRoundSequence({ A, B, style }) {
  const seq = [];

  if (Math.random() < TAUNT_CHANCE) seq.push({ type: 'taunt', content: buildTaunt(style, A, B) });

  // main action from A to B
  seq.push({ type: 'action', content: buildAction(A, B) });

  let stunned = false;
  // possible stun
  if (Math.random() < STUN_CHANCE) {
    seq.push({ type: 'stun', content: `🫨 ${B} is briefly stunned!${SFX_STRING()}` });
    stunned = true;
  }

  if (!stunned) {
    if (Math.random() < COUNTER_CHANCE) {
      seq.push({ type: 'counter', content: buildCounter(B) });
    } else {
      seq.push({ type: 'reaction', content: buildReaction(B) });
    }
  }

  // optional crit (attacker with momentum)
  if (Math.random() < CRIT_CHANCE) {
    // If counter happened, give crit to B, else A
    const last = seq.find(s => s.type === 'counter');
    seq.push({ type: 'crit', content: buildCrit(last ? B : A) });
  }

  // optional combo string
  if (COMBO_MAX > 1 && Math.random() < 0.38) {
    const hits = 2 + Math.floor(Math.random() * (COMBO_MAX - 1));
    seq.push({ type: 'combo', content: `🔁 Combo x${hits}! ${SFX_STRING()}` });
  }

  // random environmental/crowd event
  if (Math.random() < EVENTS_CHANCE) {
    const ev = randomEvent(A, B);
    if (ev) seq.push({ type: 'event', content: ev });
  }

  // occasional announcer line
  const caster = buildAnnouncer(style);
  if (caster && Math.random() < 0.6) seq.push({ type: 'announcer', content: caster });

  return seq;
}

/* ========================== Runner ========================== */
async function runRumbleDisplay({
  channel,
  baseMessage,
  challenger,
  opponent,
  bestOf = 3,
  style = (process.env.BATTLE_STYLE_DEFAULT || 'motivator').trim().toLowerCase(),
  guildName = 'this server'
}) {
  bestOf = clampBestOf(bestOf);

  // choose an environment for this match
  const env = pick(ENVIRONMENTS);
  const sim = simulateBattle({ challenger, opponent, bestOf, style });

  const Aname = challenger.displayName || challenger.username;
  const Bname = opponent.displayName   || opponent.username;
  const title = `⚔️ Rumble: ${Aname} vs ${Bname}`;

  // 1) Intro & (optional) thread
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
            description: `**Best of ${sim.bestOf}**\n**Arena:** ${env.name}\n_${env.intro}_`
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
          description: `**Best of ${sim.bestOf}**\n**Arena:** ${env.name}\n_${env.intro}_`
        }]
      });
    }
  } catch {
    if (!introMsg) {
      introMsg = await channel.send({
        embeds: [{
          color: colorFor(style),
          title,
          description: `**Best of ${sim.bestOf}**\n**Arena:** ${env.name}\n_${env.intro}_`
        }]
      });
    }
    target = channel;
  }

  await sleep(jitter(INTRO_DELAY));

  // 2) Round streaming
  for (let i = 0; i < sim.rounds.length; i++) {
    const r = sim.rounds[i];
    const bar = makeBar(r.a, r.b, sim.bestOf);

    await target.send({ content: `🔔 **Round ${i + 1} — Fight!**` });
    await sleep(jitter(Math.max(400, STEP_DELAY / 2)));

    // Sequence for this round (A=r.winner, B=r.loser purely for story; outcome fixed)
    const seq = buildRoundSequence({ A: r.winner, B: r.loser, style });

    for (const step of seq) {
      await target.send({ content: step.content });
      await sleep(jitter(STEP_DELAY));
    }

    // Official result card
    const embed = {
      color: colorFor(style),
      title: `Round ${i + 1} Result`,
      description: `**${r.winner}** beats **${r.loser}**\n\n${bar}\n\n${r.text}`,
      footer: { text: `Style: ${style} • Arena: ${env.name}` }
    };
    await target.send({ embeds: [embed] });

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
    footer: { text: `Best of ${sim.bestOf} • Style: ${style} • Arena: ${env.name}` },
  };
  if (cast) finalEmbed.fields = [{ name: '🎙️ Commentary', value: cast }];

  await target.send({ embeds: [finalEmbed] });

  // Non-threaded recap edit
  if (introMsg && !USE_THREAD) {
    await introMsg.edit({
      embeds: [{
        color: colorFor(style),
        title,
        description: `**Best of ${sim.bestOf}**\nArena: ${env.name}\nWinner: ${(champion.displayName || champion.username)} (${sim.a}-${sim.b}).`
      }]
    }).catch(() => {});
  }

  return { sim, champion };
}

module.exports = { runRumbleDisplay };

