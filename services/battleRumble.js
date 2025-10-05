// services/battleRumble.js
const { simulateBattle, aiCommentary, makeBar, clampBestOf } = require('./battleEngine');

/* ========================== Config ========================== */
const USE_THREAD   = /^true$/i.test(process.env.BATTLE_USE_THREAD || 'true');
const THREAD_NAME  = (process.env.BATTLE_THREAD_NAME || 'Rumble Royale').trim();

const INTRO_DELAY  = Math.max(200, Number(process.env.BATTLE_INTRO_DELAY_MS || 1400));
const ROUND_DELAY  = Math.max(600, Number(process.env.BATTLE_ROUND_DELAY_MS || 5200));
const JITTER_MS    = Math.max(0,   Number(process.env.BATTLE_PACE_JITTER_MS || 1200));

const ROUND_BEATS  = Math.max(2, Number(process.env.BATTLE_ROUND_BEATS || '5'));
const BEAT_DELAY   = Math.max(400, Number(process.env.BATTLE_BEAT_DELAY_MS || '1800'));

const SAFE_MODE    = !/^false$/i.test(process.env.BATTLE_SAFE_MODE || 'true');
const ANNOUNCER    = (process.env.BATTLE_ANNOUNCER || 'normal').trim().toLowerCase();

const BATTLE_THUMB_URL = (process.env.BATTLE_THUMB_URL || 'https://iili.io/KXCT1CN.png').trim();
const BATTLE_LOGO_MODE = (process.env.BATTLE_LOGO_MODE || 'author').trim().toLowerCase();

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

// Fighter icons (3D/glossy)
const ICON_A = '🔵';
const ICON_B = '🔴';

// Embed base: when BATTLE_LOGO_MODE=thumbnail, force logo to top-right via thumbnail (non-final).
function baseEmbed(style, { withLogo = true, allowThumb = true, forceThumb = false } = {}) {
  const e = { color: colorFor(style), timestamp: new Date().toISOString() };

  if (!withLogo) {
    e.author = { name: 'Rumble Royale' };
    return e;
  }

  if ((BATTLE_LOGO_MODE === 'thumbnail' || forceThumb) && allowThumb && BATTLE_THUMB_URL) {
    e.thumbnail = { url: BATTLE_THUMB_URL };          // top-right
    e.author = { name: 'Rumble Royale' };             // text stays left
  } else if (BATTLE_THUMB_URL) {
    e.author = { name: 'Rumble Royale', icon_url: BATTLE_THUMB_URL }; // small icon (top-left)
  } else {
    e.author = { name: 'Rumble Royale' };
  }
  return e;
}

function getAvatarURL(memberOrUser) {
  try {
    if (memberOrUser && typeof memberOrUser.displayAvatarURL === 'function') return memberOrUser.displayAvatarURL();
    const u = memberOrUser?.user;
    if (u && typeof u.displayAvatarURL === 'function') return u.displayAvatarURL();
  } catch {}
  return null;
}

// no-repeat picker with small memory window
function pickNoRepeat(arr, recent, cap = 6) {
  if (!arr.length) return '';
  let choice = pick(arr), tries = 0;
  while (recent.includes(choice) && tries < 12) { choice = pick(arr); tries++; }
  recent.push(choice);
  if (recent.length > cap) recent.shift();
  return choice;
}
/* Per-match memory (avoids repeats) */
function makeMemory() { return { weapons: [], verbs: [], taunts: [], scenes: [] }; }

/* ========================== Flavor ========================== */
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
function parseCsvEnv(s) { if (!exists(s)) return null; return s.split(',').map(x => x.trim()).filter(Boolean); }
const ENV_OVERRIDE = parseCsvEnv(process.env.BATTLE_ENVIRONMENTS);
const ENVIRONMENTS = ENV_OVERRIDE?.map(n => ({ name: n, intro: 'The air crackles — energy rises.' })) || ENV_BUILTIN;

// Cinematic bits
const CAMERA = [
  'Camera pans low past bootlaces.',
  'Drone swoops between the fighters.',
  'Spotlights skate across the floor.',
  'Jumbotron flickers to life.',
  'Ref’s hand hovers… and drops.'
];
const ATMOS = [
  'Crowd hushes to a sharp inhale.',
  'Bassline rattles the rails.',
  'Cold wind threads the arena.',
  'Mist rolls in from the corners.',
  'Neon buzz rises, then stills.'
];
const GROUND = [
  'Dust kicks up around their feet.',
  'Confetti shimmers in a slow fall.',
  'Cables hum under the catwalk.',
  'Sand grinds under heel turns.',
  'Tiles thrum like a heartbeat.'
];

// SFX
const SFX = ['💥','⚡','🔥','✨','💫','🫨','🌪️','🎯','🧨','🥁','📣','🔊'];
const SFX_STRING = () => SFX_ON ? ' ' + Array.from({length: 2 + Math.floor(Math.random()*3)}, () => pick(SFX)).join('') : '';

// Taunts/actions/etc. (same pools as before)
const TAUNTS = {
  clean:      [`Gloves up. Form sharp. {A} and {B} nod.`,`{A}: "Best self only." {B}: "Always."`,`Respect. Skill. Timing. Go.`],
  motivator:  [`{A}: "Clock in." {B}: "Clocked." 💪`,`{B}: "We grind clean — no excuse." ⚡`,`Breathe. Focus. Execute.`],
  villain:    [`{A}: "I’ll savor this." {B} smiles thinly.`,`Shadows coil as {A} and {B} step forward.`,`{B}: "Hope is a habit I removed."`],
  degen:      [`{A}: "Max leverage." {B}: "Full send." 🚀`,`Slippage set to chaos — {A} vs {B}.`,`{B}: "Prints only. No stops."`]
};

const W_CLEAN_SAFE = ['dojo staff','bamboo shinai','practice pads','mirror shield','focus band','training mitts'];
const W_CLEAN_SPICY= ['weighted baton (prop)','tempered shinai (spar)'];
const W_MOTI_SAFE  = ['PR belt','chalk cloud','coach whistle','rep rope','foam mace','discipline dumbbell'];
const W_MOTI_SPICY = ['iron plate (prop)','slam ball (soft)'];
const W_VILL_SAFE  = ['shadow ribbon','smoke dagger (prop)','echo bell','trick tarot','void tether (cosplay)'];
const W_VILL_SPICY = ['hex blade (prop)','cursed grimoire (cosplay)'];
const W_DEGN_SAFE  = ['alpha baton','yield yo-yo','pump trumpet','airdrop crate','ape gauntlet','vibe ledger'];
const W_DEGN_SPICY = ['leverage gloves','moon mallet (prop)'];

const WEAPONS_SAFE = ['foam bat','rubber chicken','pool noodle','pixel sword','ban hammer','yo-yo','cardboard shield','toy bo staff','glitch gauntlet'];
const WEAPONS_SPICY= ['steel chair (cosplay prop)','spiked bat (prop)','thunder gloves','meteor hammer (training)'];

const A_CLEAN = ['counters cleanly','finds spacing on','lands textbook sweep on','checks with a crisp jab on'];
const A_MOTI  = ['powers through','perfect-forms a jab on','locks in and tags','rolls momentum into'];
const A_VILL  = ['ensnares','phases through and taps','casts a snare on','drains momentum from'];
const A_DEGN  = ['market buys a combo on','leverages into','apes into','yoinks RNG from'];

const ACTIONS_SAFE = ['bonks','thwacks','boops','yeets','shoulder-bumps','jukes','spin-feints','light sweep'];
const ACTIONS_SPICY= ['smashes','ground-slams','uppercuts (spar form)','pulled haymaker'];

const REACTIONS = ['dodges','parries','blocks','shrugs it off','stumbles','perfect guards'];
const COUNTERS  = ['{B} snaps a reversal!','{B} reads it and flips momentum!','Clutch parry from {B}, instant punish!'];
const CRITS     = ['{A} finds the pixel-perfect angle — **CRIT!**','Frame trap! {A} lands a **critical** read!','{A} channels a special — it hits! **Critical!**'];

const ANNOUNCER_BANK = {
  normal:  ['Commentary: textbook spacing — beautiful footwork.','Commentary: momentum swings, crowd on edge.','Commentary: timing windows are razor thin.'],
  villain: ['Announcer: it’s delicious when hope cracks.','Announcer: watch the light drain — exquisite.','Announcer: despair taught them discipline.'],
  degen:   ['Announcer: leverage UP — liquidation candles in sight.','Announcer: full send only — printers humming.','Announcer: alpha drop mid-fight, cope rising.']
};

const CROWD   = ['Crowd roars!','Someone rings a cowbell.','A vuvuzela bleats in 8-bit.','Chants ripple through the stands.','Camera flashes pop!'];
const HAZARDS = ['Floor tiles shift suddenly!','A rogue shopping cart drifts across the arena!','Fog machine overperforms — visibility drops!','Neon sign flickers; shadows dance unpredictably!','A stray confetti cannon fires!'];
const POWERUPS= ['{X} picks up a glowing orb — speed up!','{X} grabs a pixel heart — stamina bump!','{X} equips glitch boots — dash unlocked!','{X} finds a shield bubble — temporary guard!'];

/* ========================== Builders ========================== */
function buildTaunt(style, A, B, mem) {
  const bank = TAUNTS[style] || TAUNTS.motivator;
  const line = pickNoRepeat(bank, mem.taunts, 6);
  return `🗣️ ${line.replace('{A}', A).replace('{B}', B)}`;
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
  const specific = { clean: A_CLEAN, motivator: A_MOTI, villain: A_VILL, degen: A_DEGN }[style] || [];
  return common.concat(specific);
}
function buildAction(A, B, style, mem) {
  const w = pickNoRepeat(styleWeapons(style), mem.weapons, 7);
  const v = pickNoRepeat(styleVerbs(style),   mem.verbs,   7);
  return `🥊 **${A} grabs a ${w} and ${v} ${B}!**${SFX_STRING()}`;
}
function buildReaction(B) { return `🛡️ ${B} ${pick(REACTIONS)}.${SFX_STRING()}`; }
function buildCounter(B) { return `⚡ ${(pick(COUNTERS)).replace('{B}', B)}${SFX_STRING()}`; }
function buildCrit(attacker) { return `💥 ${(pick(CRITS)).replace('{A}', attacker)}${SFX_STRING()}`; }
function randomEvent(A, B) {
  const roll = Math.random();
  if (roll < HAZARD_CHANCE) return `⚠️ ${pick(HAZARDS)}`;
  if (roll < HAZARD_CHANCE + POWERUP_CHANCE) return `🔸 ${(pick(POWERUPS)).replace('{X}', Math.random()<0.5 ? A : B)}${SFX_STRING()}`;
  if (roll < HAZARD_CHANCE + POWERUP_CHANCE + CROWD_CHANCE) return `📣 ${pick(CROWD)}`;
  return null;
}
function buildAnnouncer(style) {
  if (ANNOUNCER === 'none') return null;
  const persona = ANNOUNCER_BANK[ANNOUNCER] || ANNOUNCER_BANK.normal;
  if (Math.random() < 0.35 && ANNOUNCER_BANK[style]) return `🎙️ ${pick(ANNOUNCER_BANK[style])}`;
  return `🎙️ ${pick(persona)}`;
}
function scenicLine(env, mem) {
  const options = [
    `🎬 ${pickNoRepeat(CAMERA, mem.scenes, 8)}`,
    `🌫️ ${pickNoRepeat(ATMOS,  mem.scenes, 8)}`,
    `🏟️ ${env.name}: ${pickNoRepeat(GROUND, mem.scenes, 8)}`
  ];
  return pick(options);
}

/* ========================== Colored Bar Helpers ========================== */
function legendLine(aName, bName) {
  return `Legend: ${ICON_A} ${aName} • ${ICON_B} ${bName}`;
}
function emojiBar(aScore, bScore, width = 16, colorA = '🟦', colorB = '🟥') {
  const total = Math.max(1, aScore + bScore);
  let fillA = Math.round((aScore / total) * width);
  if (fillA < 0) fillA = 0;
  if (fillA > width) fillA = width;
  const fillB = width - fillA;
  return `${colorA.repeat(fillA)}${colorB.repeat(fillB)}`;
}
function coloredBarBlock(aName, bName, a, b, bestOf) {
  const bar = emojiBar(a, b, Math.max(10, Math.min(20, bestOf * 2)));
  return `${legendLine(aName, bName)}\n**${a}** ${bar} **${b}**`;
}

/* ========================== Embeds ========================== */
function introEmbed(style, title) {
  // forceThumb ensures top-right logo when requested
  return { ...baseEmbed(style, { withLogo: true, allowThumb: true, forceThumb: BATTLE_LOGO_MODE === 'thumbnail' }), title, description: `Rumble incoming…` };
}
function arenaEmbed(style, env, bestOf, aName, bName) {
  const sfx = SFX_STRING();
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: true, forceThumb: BATTLE_LOGO_MODE === 'thumbnail' }),
    title: `🏟️ ARENA REVEAL — ${ICON_A} ${aName} vs ${ICON_B} ${bName}`,
    description: `📣 **Welcome to ${env.name}**${sfx}\n_${env.intro}_`,
    fields: [{ name: 'Format', value: `Best of **${bestOf}**`, inline: true }],
    footer: { text: `Arena: ${env.name}` }
  };
}
function roundProgressEmbed(style, idx, env, aName, bName, linesJoined, previewBarBlock = null) {
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: true, forceThumb: BATTLE_LOGO_MODE === 'thumbnail' }),
    title: `Round ${idx} — ${ICON_A} ${aName} vs ${ICON_B} ${bName}`,
    description: previewBarBlock ? `${previewBarBlock}\n\n${linesJoined}` : `${linesJoined}`,
    footer: { text: `Arena: ${env.name}` }
  };
}
function roundFinalEmbed(style, idx, r, aName, bName, bestOf, env, wasBehind, roundText) {
  const color = wasBehind ? 0x2ecc71 : colorFor(style);
  const barBlock = coloredBarBlock(aName, bName, r.a, r.b, bestOf);
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: true, forceThumb: BATTLE_LOGO_MODE === 'thumbnail' }),
    color,
    title: `Round ${idx} — Result • ${ICON_A} ${aName} vs ${ICON_B} ${bName}`,
    description: `${barBlock}\n\n${roundText}`,
    fields: [
      { name: 'Winner', value: `${r.winner === aName ? ICON_A : ICON_B} **${r.winner}**`, inline: true },
      { name: 'Loser',  value: `${r.loser  === aName ? ICON_A : ICON_B} ${r.loser}`, inline: true },
      { name: 'Score',  value: `**${r.a}–${r.b}** (Bo${bestOf})`, inline: true },
    ],
    footer: { text: `Style: ${style} • Arena: ${env.name}` }
  };
}
function finalAllInOneEmbed({ style, sim, champion, env, cast, stats, timeline, aName, bName }) {
  const name = champion.displayName || champion.username || champion.user?.username || 'Winner';
  const avatar = getAvatarURL(champion);
  const barBlock = coloredBarBlock(aName, bName, sim.a, sim.b, sim.bestOf);
  const e = {
    ...baseEmbed(style, { withLogo: false, allowThumb: false }), // NO fixed logo on final
    title: `🏆 Final — ${ICON_A} ${aName} vs ${ICON_B} ${bName} • ${name} wins ${sim.a}-${sim.b}!`,
    description: barBlock,
    thumbnail: avatar ? { url: avatar } : undefined,
    fields: [
      { name: 'Match Stats', value:
        [
          `• Rounds: **${sim.a}-${sim.b}** (Bo${sim.bestOf})`,
          `• Taunts: **${stats.taunts}**`,
          `• Counters: **${stats.counters}**`,
          `• Crits: **${stats.crits}**`,
          `• Stuns: **${stats.stuns}**`,
          `• Combos: **${stats.combos}**`,
          `• Events: **${stats.events}**`
        ].join('\n')
      },
      { name: 'Rounds Timeline', value: timeline.slice(0, 1024) || '—' }
    ],
    footer: { text: `Style: ${style} • Arena: ${env.name}` }
  };
  if (cast) e.fields.push({ name: '🎙️ Commentary', value: cast });
  return e;
}

/* ========================== Round Sequence ========================== */
function buildRoundSequence({ A, B, style, mem }) {
  const seq = [];
  if (Math.random() < TAUNT_CHANCE) seq.push({ type: 'taunt', content: buildTaunt(style, A, B, mem) });
  seq.push({ type: 'action', content: buildAction(A, B, style, mem) });

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

/* ========================== Runner (beats) ========================== */
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
  const seed = `${channel.id}:${(challenger.id||challenger.user?.id||'A')}:${(opponent.id||opponent.user?.id||'B')}:${Date.now() >> 11}`;
  const sim = simulateBattle({ challenger, opponent, bestOf, style, seed });

  const Aname = challenger.displayName || challenger.username || challenger.user?.username || 'Challenger';
  const Bname = opponent.displayName   || opponent.username   || opponent.user?.username   || 'Opponent';
  const title = `⚔️ Rumble: ${ICON_A} ${Aname} vs ${ICON_B} ${Bname}`;

  const mem = makeMemory();
  const stats = { taunts: 0, counters: 0, crits: 0, stuns: 0, combos: 0, events: 0 };
  const roundsTimeline = [];

  // ONE intro
  let target = channel;
  try {
    if (baseMessage) {
      await baseMessage.edit({ embeds: [introEmbed(style, title)] }).catch(() => {});
      if (USE_THREAD && baseMessage.startThread) {
        const thread = await baseMessage.startThread({
          name: `${THREAD_NAME}: ${Aname} vs ${Bname}`,
          autoArchiveDuration: 60
        });
        target = thread;
      }
    } else {
      const incoming = await channel.send({ embeds: [introEmbed(style, title)] });
      if (USE_THREAD && incoming?.startThread) {
        const thread = await incoming.startThread({
          name: `${THREAD_NAME}: ${Aname} vs ${Bname}`,
          autoArchiveDuration: 60
        });
        target = thread;
      }
    }

    await sleep(jitter(INTRO_DELAY));
    await target.send({ embeds: [arenaEmbed(style, env, sim.bestOf, Aname, Bname)] });

  } catch {
    target = channel;
    await sleep(jitter(INTRO_DELAY));
    await target.send({ embeds: [arenaEmbed(style, env, sim.bestOf, Aname, Bname)] }).catch(() => {});
  }

  await sleep(jitter(INTRO_DELAY));

  // ROUNDS (single embed per round) — progressively edited across beats
  for (let i = 0; i < sim.rounds.length; i++) {
    const r = sim.rounds[i];

    const seq = buildRoundSequence({ A: r.winner, B: r.loser, style, mem });
    for (const step of seq) {
      if (step.type === 'taunt')   stats.taunts++;
      if (step.type === 'counter') stats.counters++;
      if (step.type === 'crit')    stats.crits++;
      if (step.type === 'stun')    stats.stuns++;
      if (step.type === 'combo')   stats.combos++;
      if (step.type === 'event')   stats.events++;
    }

    const lines = [];
    lines.push(scenicLine(env, mem));

    const beatsToReveal = Math.max(1, ROUND_BEATS - 1);
    const reveal = seq.slice(0, beatsToReveal).map(s => s.content);

    // preview bar (pre-round score)
    const preview = coloredBarBlock(Aname, Bname, r.a - (r.winner === Aname ? 1 : 0), r.b - (r.winner === Aname ? 0 : 1), sim.bestOf);
    let msg = await target.send({
      embeds: [roundProgressEmbed(style, i + 1, env, Aname, Bname, lines.join('\n'), preview)]
    });

    for (let b = 0; b < reveal.length; b++) {
      await sleep(jitter(BEAT_DELAY));
      lines.push(reveal[b]);
      await msg.edit({ embeds: [roundProgressEmbed(style, i + 1, env, Aname, Bname, lines.join('\n'), '⏳ …resolving round…')] });
    }

    const winnerIsA = r.winner === Aname;
    const prevA = r.a - (winnerIsA ? 1 : 0);
    const prevB = r.b - (winnerIsA ? 0 : 1);
    const wasBehind = winnerIsA ? (prevA < prevB) : (prevB < prevA);

    const roundText = lines.concat(seq.slice(beatsToReveal).map(s => s.content)).join('\n').slice(0, 1800);

    await sleep(jitter(BEAT_DELAY));
    await msg.edit({
      embeds: [roundFinalEmbed(style, i + 1, r, Aname, Bname, sim.bestOf, env, wasBehind, roundText)]
    });

    roundsTimeline.push(`R${i+1}: **${r.winner}** over ${r.loser} (${r.a}-${r.b})`);
    if (i < sim.rounds.length - 1) await sleep(jitter(ROUND_DELAY));
  }

  // Final (winner avatar, no fixed logo)
  const champion = sim.a > sim.b ? challenger : opponent;
  const runnerUp = sim.a > sim.b ? opponent  : challenger;

  let cast = null;
  try {
    cast = await aiCommentary({
      winner: champion.displayName || champion.username || champion.user?.username,
      loser:  runnerUp.displayName || runnerUp.username || runnerUp.user?.username,
      rounds: sim.rounds,
      style,
      guildName
    });
  } catch {}

  const timeline = roundsTimeline.join(' • ');
  await target.send({ embeds: [finalAllInOneEmbed({
    style, sim, champion, env, cast, stats, timeline, aName: Aname, bName: Bname
  })] });

  return { sim, champion };
}

module.exports = { runRumbleDisplay };







