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
function parseCsvEnv(s) { if (!exists(s)) return null; return s.split(',').map(x => x.trim()).filter(Boolean); }

/* ========================== Flavor ========================== */
// Environments (more scenes!)
const ENV_BUILTIN = [
  { name: 'Neon Rooftop', intro: 'City lights hum below; the wind carries hype.' },
  { name: 'Underground Dojo', intro: 'Paper walls, sand floor, respectful echoes.' },
  { name: 'Pixel Coliseum', intro: 'Crowd rendered at 60fps — their chant buffers in.' },
  { name: 'Synthwave Boardwalk', intro: 'Waves slap the pier; a neon crane game watches.' },
  { name: 'Server Room Arena', intro: 'Fans whirr; LEDs blink like judging eyes.' },
  { name: 'Data Center Catwalk', intro: 'Cables like vines, AC like a storm.' },
  { name: 'Deserted Arcade', intro: 'CRT glow, coin chimes, boss music faint.' },
  { name: 'Gravity Gym', intro: 'Chalk in the air; plates clink like bells.' },
  { name: 'Skybridge Circuit', intro: 'Holograms flicker, drones spectate.' },
  { name: 'Metro Tunnels', intro: 'Rails sing; echoes cheer.' },
  { name: 'Glitch Forest', intro: 'Leaves clip; birds lag; mythic latency.' },
  { name: 'Crystal Cavern', intro: 'Light refracts; steps ring clear.' },
  { name: 'Futurist Museum', intro: 'Art stares back; history watches.' },
  { name: 'Hacker Loft', intro: 'Neon code rains across the wall.' },
  { name: 'Hyperdome', intro: 'Announcer checks mic — reverb perfect.' },
];
const ENV_OVERRIDE = parseCsvEnv(process.env.BATTLE_ENVIRONMENTS);
const ENVIRONMENTS = ENV_OVERRIDE?.map(n => ({ name: n, intro: 'The air crackles — energy rises.' })) || ENV_BUILTIN;

// SFX
const SFX = ['💥','⚡','🔥','✨','💫','🫨','🌪️','🎯','🧨','🥁','📣','🔊'];
const SFX_STRING = () => SFX_ON ? ' ' + Array.from({length: 2 + Math.floor(Math.random()*3)}, () => pick(SFX)).join('') : '';

// Taunts
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

// Style-specific weapon pools (safe + spicy add-ons)
const W_CLEAN_SAFE = ['dojo staff','bamboo shinai','practice pads','mirror shield','focus band','training mitts'];
const W_CLEAN_SPICY= ['weighted baton (prop)','tempered shinai (spar)'];

const W_MOTI_SAFE  = ['PR belt','chalk cloud','coach whistle','rep rope','foam mace','discipline dumbbell'];
const W_MOTI_SPICY = ['iron plate (prop)','slam ball (soft)'];

const W_VILL_SAFE  = ['shadow ribbon','smoke dagger (prop)','echo bell','trick tarot','void tether (cosplay)'];
const W_VILL_SPICY = ['hex blade (prop)','cursed grimoire (cosplay)'];

const W_DEGN_SAFE  = ['alpha baton','yield yo-yo','pump trumpet','airdrop crate','ape gauntlet','vibe ledger'];
const W_DEGN_SPICY = ['leverage gloves','moon mallet (prop)'];

// Generic pools for variety
const WEAPONS_SAFE = [
  'foam bat','rubber chicken','pool noodle','pixel sword','ban hammer',
  'yo-yo','cardboard shield','toy bo staff','glitch gauntlet'
];
const WEAPONS_SPICY = ['steel chair (cosplay prop)','spiked bat (prop)','thunder gloves','meteor hammer (training)'];

// Actions (style-aware)
const A_CLEAN = ['counters cleanly','finds spacing on','lands textbook sweep on','checks with a crisp jab on'];
const A_MOTI  = ['powers through','perfect-forms a jab on','locks in and tags','rolls momentum into'];
const A_VILL  = ['ensnares','phases through and taps','casts a snare on','drains momentum from'];
const A_DEGN  = ['market buys a combo on','leverages into','apes into','yoinks RNG from'];

const ACTIONS_SAFE = ['bonks','thwacks','boops','yeets','shoulder-bumps','jukes','spin-feints','light sweep'];
const ACTIONS_SPICY= ['smashes','ground-slams','uppercuts (spar form)','pulled haymaker'];

// Reactions / counters / crits
const REACTIONS = ['dodges','parries','blocks','shrugs it off','stumbles','perfect guards'];
const COUNTERS = ['{B} snaps a reversal!','{B} reads it and flips momentum!','Clutch parry from {B}, instant punish!'];
const CRITS = ['{A} finds the pixel-perfect angle — **CRIT!**','Frame trap! {A} lands a **critical** read!','{A} channels a special — it hits! **Critical!**'];

// Announcer personas
const ANNOUNCER_BANK = {
  normal: ['Commentary: textbook spacing — beautiful footwork.','Commentary: momentum swings, crowd on edge.','Commentary: timing windows are razor thin.'],
  villain:['Announcer: it’s delicious when hope cracks.','Announcer: watch the light drain — exquisite.','Announcer: despair taught them discipline.'],
  degen:  ['Announcer: leverage UP — liquidation candles in sight.','Announcer: full send only — printers humming.','Announcer: alpha drop mid-fight, cope rising.']
};

// Crowd / hazards / powerups
const CROWD   = ['Crowd roars!','Someone rings a cowbell.','A vuvuzela bleats in 8-bit.','Chants ripple through the stands.','Camera flashes pop!'];
const HAZARDS = ['Floor tiles shift suddenly!','A rogue shopping cart drifts across the arena!','Fog machine overperforms — visibility drops!','Neon sign flickers; shadows dance unpredictably!','A stray confetti cannon fires!'];
const POWERUPS= ['{X} picks up a glowing orb — speed up!','{X} grabs a pixel heart — stamina bump!','{X} equips glitch boots — dash unlocked!','{X} finds a shield bubble — temporary guard!'];

/* ========================== Builders ========================== */
function buildTaunt(style, A, B) {
  const bank = TAUNTS[style] || TAUNTS.motivator;
  return `🗣️ ${pick(bank).replace('{A}', A).replace('{B}', B)}`;
}
function styleWeapons(style){
  const base = SAFE_MODE ? WEAPONS_SAFE.slice() : WEAPONS_SAFE.concat(WEAPONS_SPICY);
  const add = {
    clean: SAFE_MODE ? W_CLEAN_SAFE : W_CLEAN_SAFE.concat(W_CLEAN_SPICY),
    motivator: SAFE_MODE ? W_MOTI_SAFE : W_MOTI_SAFE.concat(W_MOTI_SPICY),
    villain: SAFE_MODE ? W_VILL_SAFE : W_VILL_SAFE.concat(W_VILL_SPICY),
    degen: SAFE_MODE ? W_DEGN_SAFE  : W_DEGN_SAFE.concat(W_DEGN_SPICY)
  }[style] || [];
  return base.concat(add);
}
function styleVerbs(style){
  const common = SAFE_MODE ? ACTIONS_SAFE : ACTIONS_SAFE.concat(ACTIONS_SPICY);
  const specific = {
    clean: A_CLEAN, motivator: A_MOTI, villain: A_VILL, degen: A_DEGN
  }[style] || [];
  return common.concat(specific);
}
function buildAction(A, B, style) {
  const w = pick(styleWeapons(style));
  const v = pick(styleVerbs(style));
  return `🥊 **${A} grabs a ${w} and ${v} ${B}!**${SFX_STRING()}`;
}
function buildReaction(B) { return `🛡️ ${B} ${pick(REACTIONS)}.${SFX_STRING()}`; }
function buildCounter(B) { return `⚡ ${pick(COUNTERS).replace('{B}', B)}${SFX_STRING()}`; }
function buildCrit(attacker) { return `💥 ${pick(CRITS).replace('{A}', attacker)}${SFX_STRING()}`; }

function randomEvent(A, B) {
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
  if (Math.random() < 0.35 && ANNOUNCER_BANK[style]) return `🎙️ ${pick(ANNOUNCER_BANK[style])}`;
  return `🎙️ ${line}`;
}

function buildRoundSequence({ A, B, style }) {
  const seq = [];
  if (Math.random() < TAUNT_CHANCE) seq.push({ type: 'taunt', content: buildTaunt(style, A, B) });

  seq.push({ type: 'action', content: buildAction(A, B, style) });

  let stunned = false;
  if (Math.random() < STUN_CHANCE) { seq.push({ type: 'stun', content: `🫨 ${B} is briefly stunned!${SFX_STRING()}` }); stunned = true; }

  if (!stunned) {
    if (Math.random() < COUNTER_CHANCE) seq.push({ type: 'counter', content: buildCounter(B) });
    else seq.push({ type: 'reaction', content: buildReaction(B) });
  }

  if (Math.random() < CRIT_CHANCE) {
    const last = seq.find(s => s.type === 'counter');
    seq.push({ type: 'crit', content: buildCrit(last ? B : A) });
  }

  if (COMBO_MAX > 1 && Math.random() < 0.38) {
    const hits = 2 + Math.floor(Math.random() * (COMBO_MAX - 1));
    seq.push({ type: 'combo', content: `🔁 Combo x${hits}! ${SFX_STRING()}` });
  }

  if (Math.random() < EVENTS_CHANCE) {
    const ev = randomEvent(A, B);
    if (ev) seq.push({ type: 'event', content: ev });
  }

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
        introMsg = await channel.send({ embeds: [introEmbed(style, title, sim.bestOf, env)] });
        const thread = await introMsg.startThread({
          name: `${THREAD_NAME}: ${Aname} vs ${Bname}`,
          autoArchiveDuration: 60
        });
        target = thread;
      }
    } else if (!introMsg) {
      introMsg = await channel.send({ embeds: [introEmbed(style, title, sim.bestOf, env)] });
    }
  } catch {
    if (!introMsg) introMsg = await channel.send({ embeds: [introEmbed(style, title, sim.bestOf, env)] });
    target = channel;
  }

  await sleep(jitter(INTRO_DELAY));

  // 2) Round streaming
  for (let i = 0; i < sim.rounds.length; i++) {
    const r = sim.rounds[i];
    const bar = makeBar(r.a, r.b, sim.bestOf);

    await target.send({ embeds: [miniHeaderEmbed(style, `🔔 Round ${i + 1} — Fight!`, env)] });
    await sleep(jitter(Math.max(400, STEP_DELAY / 2)));

    const seq = buildRoundSequence({ A: r.winner, B: r.loser, style });
    for (const step of seq) {
      await target.send({ content: step.content });
      await sleep(jitter(STEP_DELAY));
    }

    // Official round card
    await target.send({ embeds: [roundEmbed(style, i + 1, r, bar, sim.bestOf, env)] });

    if (i < sim.rounds.length - 1) await sleep(jitter(ROUND_DELAY));
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

  await target.send({ embeds: [finalEmbed(style, sim, champion, finalBar, env, cast)] });

  if (introMsg && !USE_THREAD) {
    await introMsg.edit({ embeds: [recapEmbed(style, sim, champion, env)] }).catch(() => {});
  }

  return { sim, champion };
}

/* ========================== Embed builders ========================== */
function baseEmbed(style) {
  return {
    color: colorFor(style),
    author: { name: 'Rumble Royale' },
    timestamp: new Date().toISOString(),
  };
}
function introEmbed(style, title, bestOf, env) {
  return {
    ...baseEmbed(style),
    title,
    description: `**Best of ${bestOf}**`,
    fields: [
      { name: 'Arena', value: `**${env.name}**\n_${env.intro}_`, inline: false },
    ],
    footer: { text: `Style: ${style} • Arena: ${env.name}` }
  };
}
function miniHeaderEmbed(style, text, env) {
  return {
    ...baseEmbed(style),
    description: text,
    footer: { text: `Arena: ${env.name}` }
  };
}
function roundEmbed(style, idx, r, bar, bestOf, env) {
  return {
    ...baseEmbed(style),
    title: `Round ${idx} — Result`,
    description: `${bar}\n\n${r.text}`,
    fields: [
      { name: 'Winner', value: `**${r.winner}**`, inline: true },
      { name: 'Loser',  value: `${r.loser}`, inline: true },
      { name: 'Score',  value: `**${r.a}–${r.b}** (Best of ${bestOf})`, inline: true },
    ],
    footer: { text: `Style: ${style} • Arena: ${env.name}` }
  };
}
function finalEmbed(style, sim, champion, bar, env, cast) {
  const name = champion.displayName || champion.username;
  const e = {
    ...baseEmbed(style),
    title: `🏆 Final — ${name} wins ${sim.a}-${sim.b}!`,
    description: bar,
    footer: { text: `Best of ${sim.bestOf} • Style: ${style} • Arena: ${env.name}` }
  };
  if (cast) e.fields = [{ name: '🎙️ Commentary', value: cast }];
  return e;
}
function recapEmbed(style, sim, champion, env) {
  const name = champion.displayName || champion.username;
  return {
    ...baseEmbed(style),
    title: 'Rumble Complete',
    description: `Winner: **${name}** (${sim.a}-${sim.b})`,
    footer: { text: `Best of ${sim.bestOf} • Style: ${style} • Arena: ${env.name}` }
  };
}

module.exports = { runRumbleDisplay };


