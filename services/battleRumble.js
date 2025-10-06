// services/battleRumble.js
const { simulateBattle, aiCommentary, makeBar, clampBestOf } = require('./battleEngine');

/* ========================== Config ========================== */
const USE_THREAD   = /^true$/i.test(process.env.BATTLE_USE_THREAD || 'false');
const THREAD_NAME  = (process.env.BATTLE_THREAD_NAME || 'Rumble Royale').trim();

// Global pacing multiplier (slow things down a bit by default)
const PACE_MULT = Math.max(0.5, Number(process.env.BATTLE_PACE_MULTIPLIER || 1.25));

const INTRO_DELAY  = Math.max(200, Math.round((Number(process.env.BATTLE_INTRO_DELAY_MS || 1400)) * PACE_MULT));
const ROUND_DELAY  = Math.max(600, Math.round((Number(process.env.BATTLE_ROUND_DELAY_MS || 5200)) * PACE_MULT));
const JITTER_MS    = Math.max(0,   Number(process.env.BATTLE_PACE_JITTER_MS || 1200));

// Pacing within each round (progressive embed edits)
const ROUND_BEATS  = Math.max(2, Number(process.env.BATTLE_ROUND_BEATS || '5'));
const BEAT_DELAY   = Math.max(400, Math.round((Number(process.env.BATTLE_BEAT_DELAY_MS || '1800')) * PACE_MULT));

const SAFE_MODE    = !/^false$/i.test(process.env.BATTLE_SAFE_MODE || 'true');
const ANNOUNCER    = (process.env.BATTLE_ANNOUNCER || 'normal').trim().toLowerCase();

// Logo options:
const BATTLE_THUMB_URL = (process.env.BATTLE_THUMB_URL || 'https://iili.io/KXCT1CN.png').trim();
const BATTLE_LOGO_MODE = (process.env.BATTLE_LOGO_MODE || 'thumbnail').trim().toLowerCase();

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

// cross-match recency windows (tunable)
const ARENA_RECENT_WINDOW  = Math.max(2, Number(process.env.BATTLE_ENV_RECENT || 5));
const WEAPON_RECENT_WINDOW = Math.max(3, Number(process.env.BATTLE_WEAPON_RECENT || 10));
const VERB_RECENT_WINDOW   = Math.max(3, Number(process.env.BATTLE_VERB_RECENT || 10));

function clamp01(x){ x = Number(x); if (!isFinite(x)) return 0; return Math.min(1, Math.max(0, x)); }

/* ========================== Utils ========================== */
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (base) => base + Math.floor((Math.random() * 2 - 1) * JITTER_MS);
const pick   = (arr) => arr[Math.floor(Math.random() * arr.length)];
const exists = (s) => typeof s === 'string' && s.trim().length > 0;

// NEW: dark “strip” per line inside the embed using inline code style
const dark = (s) => `\`${s}\``;
const formatFeed = (lines) => lines.map(dark).join('\n');

function colorFor(style) {
  return style === 'villain' ? 0x8b0000
       : style === 'degen'   ? 0xe67e22
       : style === 'clean'   ? 0x3498db
       : 0x9b59b6;
}

// Small author icon (left) OR thumbnail (right) based on env
function baseEmbed(style, { withLogo = true, allowThumb = true } = {}) {
  const e = {
    color: colorFor(style),
    timestamp: new Date().toISOString()
  };

  if (withLogo && BATTLE_THUMB_URL) {
    if (BATTLE_LOGO_MODE === 'thumbnail' && allowThumb) {
      e.thumbnail = { url: BATTLE_THUMB_URL }; // top-right
      e.author = { name: 'Rumble Royale' };
    } else {
      e.author = { name: 'Rumble Royale', icon_url: BATTLE_THUMB_URL }; // small icon (top-left)
    }
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

// no-repeat picker with small memory window (per-match)
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

/* ========================== Cross-Match Recency Stores ========================== */
const _arenaRecentByGuild = new Map(); // guildId -> [arenaName,...]
const _recentGlobal = new Map();       // key -> [item,...]

function getRecentList(key) {
  const arr = _recentGlobal.get(key) || [];
  _recentGlobal.set(key, arr);
  return arr;
}
function updateRecentList(key, item, cap) {
  const arr = getRecentList(key);
  if (item && !arr.includes(item)) arr.push(item);
  while (arr.length > cap) arr.shift();
}
function filterByRecent(list, key, cap) {
  const recent = getRecentList(key);
  const filtered = list.filter(x => !recent.includes(x));
  return filtered.length >= Math.ceil(list.length * 0.4) ? filtered : list;
}
function chooseEnvironment(channel, environments) {
  const gid = channel?.guildId || 'global';
  const recent = _arenaRecentByGuild.get(gid) || [];
  const candidates = environments.filter(e => !recent.includes(e.name));
  const pickedEnv = (candidates.length ? pick(candidates) : pick(environments));
  const next = recent.concat([pickedEnv.name]).slice(-ARENA_RECENT_WINDOW);
  _arenaRecentByGuild.set(gid, next);
  return pickedEnv;
}

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
  // new variety
  { name: 'Aurora Ice Rink', intro: 'Frost breath in neon; blades sing on ice.' },
  { name: 'Volcano Rim', intro: 'Heat shimmer; sparks float like stars.' },
  { name: 'Mecha Hangar', intro: 'Hydraulics hiss; warning lights blink.' },
  { name: 'Cyber Bazaar', intro: 'Vendors cheer; drones barter overhead.' },
  { name: 'Zen Garden Deck', intro: 'Raked sand; koi ripple to distant drums.' },
  { name: 'Sky Arena 404', intro: 'Platform boots up; clouds scroll beneath.' },
  { name: 'Solar Array', intro: 'Panels gleam; sun drums a steady beat.' },
  { name: 'Noir Backlot', intro: 'Rain on set; a spotlight cuts the fog.' },
  { name: 'Junkyard Circuit', intro: 'Metal chorus; sparks and grit fly.' },
  { name: 'Holo Theater', intro: 'Curtains of light; crowd phases in.' },
  { name: 'Subway Concourse', intro: 'Announcements echo; sneakers squeak.' },
  { name: 'Starlit Rooftop', intro: 'Constellations watch like judges.' },
  { name: 'Quantum Track', intro: 'Footsteps desync; time smears and snaps.' },
  { name: 'Temple Steps', intro: 'Incense curls; drums set the cadence.' },
  { name: 'Cloud Pier', intro: 'Sea of mist; gulls glitch in and out.' },
];
function parseCsvEnv(s) { if (!exists(s)) return null; return s.split(',').map(x => x.trim()).filter(Boolean); }
const ENV_OVERRIDE = parseCsvEnv(process.env.BATTLE_ENVIRONMENTS);
const ENVIRONMENTS = ENV_OVERRIDE?.map(n => ({ name: n, intro: 'The air crackles — energy rises.' })) || ENV_BUILTIN;

const CAMERA = [
  'Camera pans low past bootlaces.',
  'Drone swoops between the fighters.',
  'Spotlights skate across the floor.',
  'Jumbotron flickers to life.',
  'Ref’s hand hovers… and drops.',
  'Slow dolly in; gloves tighten.',
  'Top-down orbit; crowd becomes a halo.',
  'Ref nods; the world narrows to two.',
];
const ATMOS = [
  'Crowd hushes to a sharp inhale.',
  'Bassline rattles the rails.',
  'Cold wind threads the arena.',
  'Mist rolls in from the corners.',
  'Neon buzz rises, then stills.',
  'Speaker crackle hints at chaos.',
  'Confetti cannons reload somewhere.',
  'A banner unfurls; slogans roar.',
];
const GROUND = [
  'Dust kicks up around their feet.',
  'Confetti shimmers in a slow fall.',
  'Cables hum under the catwalk.',
  'Sand grinds under heel turns.',
  'Tiles thrum like a heartbeat.',
  'Metal grates sing underfoot.',
  'LED tiles ripple with each step.',
  'Puddles mirror the hype lights.',
];

// SFX
const SFX = ['💥','⚡','🔥','✨','💫','🫨','🌪️','🎯','🧨','🥁','📣','🔊'];
const SFX_STRING = () => SFX_ON ? ' ' + Array.from({length: 2 + Math.floor(Math.random()*3)}, () => pick(SFX)).join('') : '';

// Taunts
const TAUNTS = {
  clean:      [`Gloves up. Form sharp. {A} and {B} nod.`,`{A}: "Best self only." {B}: "Always."`,`Respect. Skill. Timing. Go.`],
  motivator:  [`{A}: "Clock in." {B}: "Clocked." 💪`,`{B}: "We grind clean — no excuse." ⚡`,`Breathe. Focus. Execute.`],
  villain:    [`{A}: "I’ll savor this." {B} smiles thinly.`,`Shadows coil as {A} and {B} step forward.`,`{B}: "Hope is a habit I removed."`],
  degen:      [`{A}: "Max leverage." {B}: "Full send." 🚀`,`Slippage set to chaos — {A} vs {B}.`,`{B}: "Prints only. No stops."`]
};

// Style-specific weapons/actions (expanded)
const W_CLEAN_SAFE = [
  'dojo staff','bamboo shinai','practice pads','mirror shield','focus band','training mitts',
  'wooden tonfa','soft nunchaku','foam sai','balance board','kata fan'
];
const W_CLEAN_SPICY= ['weighted baton (prop)','tempered shinai (spar)','practice spear (prop)'];

const W_MOTI_SAFE  = [
  'PR belt','chalk cloud','coach whistle','rep rope','foam mace','discipline dumbbell',
  'timer cube','resistance band','speed ladder','focus cone','agility hurdle'
];
const W_MOTI_SPICY = ['iron plate (prop)','slam ball (soft)','training kettlebell (prop)'];

const W_VILL_SAFE  = [
  'shadow ribbon','smoke dagger (prop)','echo bell','trick tarot','void tether (cosplay)',
  'illusion orb','stage mask','smoke fan','mirror shard (prop)'
];
const W_VILL_SPICY = ['hex blade (prop)','cursed grimoire (cosplay)','phantom chain (prop)'];

const W_DEGN_SAFE  = [
  'alpha baton','yield yo-yo','pump trumpet','airdrop crate','ape gauntlet','vibe ledger',
  'meme shield','copium canister','hopium horn','rug detector','dip net'
];
const W_DEGN_SPICY = ['leverage gloves','moon mallet (prop)','margin mace (prop)'];

const WEAPONS_SAFE = [
  'foam bat','rubber chicken','pool noodle','pixel sword','ban hammer','yo-yo','cardboard shield','toy bo staff','glitch gauntlet',
  'bubble blaster','spring glove','confetti popper','karate board (breakaway)','nerf spear'
];
const WEAPONS_SPICY= ['steel chair (cosplay prop)','spiked bat (prop)','thunder gloves','meteor hammer (training)','breakaway bottle (prop)'];

const A_CLEAN = ['counters cleanly','finds spacing on','lands textbook sweep on','checks with a crisp jab on','punctuates a perfect step on'];
const A_MOTI  = ['powers through','perfect-forms a jab on','locks in and tags','rolls momentum into','chains footwork into'];
const A_VILL  = ['ensnares','phases through and taps','casts a snare on','drains momentum from','twists fate around'];
const A_DEGN  = ['market buys a combo on','leverages into','apes into','yoinks RNG from','front-runs the angle on'];

const ACTIONS_SAFE = ['bonks','thwacks','boops','yeets','shoulder-bumps','jukes','spin-feints','light sweep','checks low','tags the guard'];
const ACTIONS_SPICY= ['smashes','ground-slams','uppercuts (spar form)','pulled haymaker','vaults through the gap'];

const REACTIONS = ['dodges','parries','blocks','shrugs it off','stumbles','perfect guards','rolls out','slides back'];
const COUNTERS  = ['{B} snaps a reversal!','{B} reads it and flips momentum!','Clutch parry from {B}, instant punish!','{B} side-steps, punish window found!'];
const CRITS     = ['{A} finds the pixel-perfect angle — **CRIT!**','Frame trap! {A} lands a **critical** read!','{A} channels a special — it hits! **Critical!**','Counter-hit spark — **CRIT!** for {A}!'];

const ANNOUNCER_BANK = {
  normal:  ['Commentary: textbook spacing — beautiful footwork.','Commentary: momentum swings, crowd on edge.','Commentary: timing windows are razor thin.'],
  villain: ['Announcer: it’s delicious when hope cracks.','Announcer: watch the light drain — exquisite.','Announcer: despair taught them discipline.'],
  degen:   ['Announcer: leverage UP — liquidation candles in sight.','Announcer: full send only — printers humming.','Announcer: alpha drop mid-fight, cope rising.']
};

const CROWD   = ['Crowd roars!','Someone rings a cowbell.','A vuvuzela bleats in 8-bit.','Chants ripple through the stands.','Camera flashes pop!','Wave starts in section B.'];
const HAZARDS = ['Floor tiles shift suddenly!','A rogue shopping cart drifts across the arena!','Fog machine overperforms — visibility drops!','Neon sign flickers; shadows dance unpredictably!','A stray confetti cannon fires!','Stage cable snags a foot!'];
const POWERUPS= ['{X} picks up a glowing orb — speed up!','{X} grabs a pixel heart — stamina bump!','{X} equips glitch boots — dash unlocked!','{X} finds a shield bubble — temporary guard!','{X} slots a power chip — timing buff!'];

// NEW: micro-movement / defense / evasion pools for longer rounds
const MOVES = [
  'angles off the center','cuts the lane','resets to neutral','shadows the footwork','drifts toward the ropes',
  'switches stance','slides back a half step','pressures to the edge','reclaims mid','circles into open space'
];
const DEFENDS = [
  'checks the guard','slips the jab','frame-blocks clean','covers the body','peeks behind the shoulder',
  'parries on reaction','rides the impact','turtles briefly','shoulder rolls','guards high, elbows tight'
];
const EVADE = [
  'sidesteps cleanly','micro-dashes out','backsteps at the bell','shimmy-feints the hook','duck-and-weaves under heat'
];

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
  const wKey = `wep:${style}`;
  const vKey = `vrb:${style}`;
  const wList = filterByRecent(styleWeapons(style), wKey, WEAPON_RECENT_WINDOW);
  const vList = filterByRecent(styleVerbs(style),   vKey, VERB_RECENT_WINDOW);

  const w = pickNoRepeat(wList, mem.weapons, 7);
  const v = pickNoRepeat(vList, mem.verbs,   7);

  updateRecentList(wKey, w, WEAPON_RECENT_WINDOW);
  updateRecentList(vKey, v, VERB_RECENT_WINDOW);

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
function buildMove(A, B) { return `🌀 ${A} ${pick(MOVES)}; ${B} stays alert.`; }
function buildDefense(B) { return `🛡️ ${B} ${pick(DEFENDS)}.`; }
function buildEvade(B)   { return `🪽 ${B} ${pick(EVADE)}.`; }
function buildSwap(X, style, mem) {
  const wKey = `wep:${style}`;
  const wList = filterByRecent(styleWeapons(style), wKey, WEAPON_RECENT_WINDOW);
  const w = pickNoRepeat(wList, mem.weapons, 7);
  updateRecentList(wKey, w, WEAPON_RECENT_WINDOW);
  return `🔧 ${X} swaps to a ${w}.`;
}

// Scenic line (no-repeat-ish)
function scenicLine(env, mem) {
  const options = [
    `🎬 ${pickNoRepeat(CAMERA, mem.scenes, 8)}`,
    `🌫️ ${pickNoRepeat(ATMOS,  mem.scenes, 8)}`,
    `🏟️ ${env.name}: ${pickNoRepeat(GROUND, mem.scenes, 8)}`
  ];
  return pick(options);
}

/* ========================== Colored Bar Helpers ========================== */
function legendLine(aName, bName, colorA = '🟦', colorB = '🟥') {
  return `Legend: ${colorA} ${aName} • ${colorB} ${bName}`;
}
function emojiBar(aScore, bScore, width = 16, colorA = '🟦', colorB = '🟥', empty = '⬜') {
  const total = Math.max(1, aScore + bScore);
  let fillA = Math.round((aScore / total) * width);
  if (fillA < 0) fillA = 0;
  if (fillA > width) fillA = width;
  const fillB = width - fillA;
  return `${colorA.repeat(fillA)}${empty.repeat(0)}${colorB.repeat(fillB)}`;
}
function coloredBarBlock(aName, bName, a, b, bestOf) {
  const bar = emojiBar(a, b, Math.max(10, Math.min(20, bestOf * 2)));
  return `${legendLine(aName, bName)}\n**${a}** ${bar} **${b}**`;
}

/* ========================== Embeds ========================== */
function introEmbed(style, title) {
  return { ...baseEmbed(style, { withLogo: true, allowThumb: true }), title, description: `Rumble incoming…` };
}
function arenaEmbed(style, env, bestOf) {
  const sfx = SFX_STRING();
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: true }),
    title: `🏟️ ARENA REVEAL`,
    description: `📣 **Welcome to ${env.name}**${sfx}\n_${env.intro}_`,
    fields: [{ name: 'Format', value: `Best of **${bestOf}**`, inline: true }],
    footer: { text: `Arena: ${env.name}` }
  };
}
function roundProgressEmbed(style, idx, env, linesJoined, previewBarBlock = null) {
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: true }),
    title: `Round ${idx} — Action Feed`,
    description: previewBarBlock ? `${previewBarBlock}\n\n${linesJoined}` : `${linesJoined}`,
    footer: { text: `Arena: ${env.name}` }
  };
}
function roundFinalEmbed(style, idx, r, aName, bName, bestOf, env, wasBehind, roundText) {
  const color = wasBehind ? 0x2ecc71 /* green */ : colorFor(style);
  const barBlock = coloredBarBlock(aName, bName, r.a, r.b, bestOf);
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: true }),
    color,
    title: `Round ${idx} — Result`,
    description: `${barBlock}\n\n${roundText}`,
    fields: [
      { name: 'Winner', value: `**${r.winner}**`, inline: true },
      { name: 'Loser',  value: `${r.loser}`, inline: true },
      { name: 'Score',  value: `**${r.a}–${r.b}** (Bo${bestOf})`, inline: true },
    ],
    footer: { text: `Style: ${style} • Arena: ${env.name}` }
  };
}
function finalAllInOneEmbed({ style, sim, champion, env, cast, stats, timeline, aName, bName, podium = null }) {
  const name = champion.displayName || champion.username || champion.user?.username || 'Winner';
  const avatar = getAvatarURL(champion);
  const barBlock = coloredBarBlock(aName, bName, sim.a, sim.b, sim.bestOf);

  const e = {
    ...baseEmbed(style, { withLogo: false, allowThumb: false }), // NO fixed logo on final
    title: `🏆 Final — ${name} wins ${sim.a}-${sim.b}!`,
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

  // Optional podium (for royale/bracket). Spacer before commentary either way.
  if (Array.isArray(podium) && podium.length) {
    const lines = podium.slice(0,3).map((u, i) => `${i===0?'🥇':i===1?'🥈':'🥉'} ${u}`).join('\n');
    e.fields.push({ name: 'Top 3', value: lines || '—' });
  }
  e.fields.push({ name: '\u200B', value: '\u200B' });

  if (cast) e.fields.push({ name: '🎙️ Commentary', value: cast });

  return e;
}

/* ========================== Round Sequence (ENRICHED) ========================== */
function buildRoundSequence({ A, B, style, mem }) {
  const seq = [];

  // Optional opener taunt
  if (Math.random() < TAUNT_CHANCE) seq.push({ type: 'taunt', content: buildTaunt(style, A, B, mem) });

  // Opener action
  seq.push({ type: 'action', content: buildAction(A, B, style, mem) });

  // Mid-round scramble: add 2–4 micro beats (move/defend/evade/swap)
  const microBeats = 2 + Math.floor(Math.random() * 3); // 2..4
  for (let i = 0; i < microBeats; i++) {
    const roll = Math.random();
    if (roll < 0.30) seq.push({ type: 'move',    content: buildMove(A, B) });
    else if (roll < 0.55) seq.push({ type: 'def', content: buildDefense(B) });
    else if (roll < 0.75) seq.push({ type: 'evd', content: buildEvade(B) });
    else                   seq.push({ type: 'swap', content: buildSwap(Math.random()<0.5 ? A : B, style, mem) });
  }

  // Stun check
  let stunned = false;
  if (Math.random() < STUN_CHANCE) {
    seq.push({ type: 'stun', content: `🫨 ${B} is briefly stunned!${SFX_STRING()}` });
    stunned = true;
  }

  // Reaction / Counter
  let didCounter = false;
  if (!stunned) {
    if (Math.random() < COUNTER_CHANCE) { seq.push({ type: 'counter', content: buildCounter(B) }); didCounter = true; }
    else seq.push({ type: 'reaction', content: buildReaction(B) });
  }

  // If counter happened, let B follow up with a quick action
  if (didCounter && Math.random() < 0.7) {
    seq.push({ type: 'actionB', content: buildAction(B, A, style, mem) });
  }

  // Crit chance (attacker depends on last momentum)
  if (Math.random() < CRIT_CHANCE) {
    const lastCounter = seq.find(s => s.type === 'counter' || s.type === 'actionB');
    seq.push({ type: 'crit', content: buildCrit(lastCounter ? B : A) });
  }

  // Optional combo burst
  if (COMBO_MAX > 1 && Math.random() < 0.45) {
    const hits = 2 + Math.floor(Math.random() * (COMBO_MAX - 1));
    seq.push({ type: 'combo', content: `🔁 Combo x${hits}! ${SFX_STRING()}` });
  }

  // Random environment/crowd events
  if (Math.random() < EVENTS_CHANCE) {
    const ev = randomEvent(A, B);
    if (ev) seq.push({ type: 'event', content: ev });
  }

  // Occasional announcer line
  const caster = buildAnnouncer(style);
  if (caster && Math.random() < 0.6) seq.push({ type: 'announcer', content: caster });

  return seq;
}

/* ========================== Commentary sanitize helpers ========================== */
function stripThinkBlocks(text) {
  if (!text) return '';
  let out = String(text);

  out = out.replace(/```[\s\S]*?```/g, ' ');
  const openIdx = out.search(/<\s*(think|analysis|reasoning|reflection)\b/i);
  if (openIdx !== -1) out = out.slice(0, openIdx);
  out = out.replace(/<\s*\/?\s*(think|analysis|reasoning|reflection)[^>]*>/gi, ' ');
  out = out.replace(/^\s*(analysis|think|reasoning|reflection)\s*:\s*/gim, '');
  out = out.replace(/^\s*(commentary|notes?)\s*:?\s*$/gim, '');
  out = out.replace(/^\s*(okay|alright|first,|let'?s|i need to|i should|i will|here'?s)\b.*$/gim, '');
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

function safeLinesOnly(text, maxLines = 3, maxLen = 140) {
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !/^<\w+>/.test(s) && !/<\/\w+>/.test(s))
    .map(s => (s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s))
  ;
  if (lines.length <= 1) {
    const chunk = lines[0] || text;
    return chunk.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, maxLines);
  }
  return lines.slice(0, maxLines);
}

function styleFallbackLines(style, winner, loser) {
  const w = winner || 'Winner';
  const l = loser || 'Runner-up';
  switch (style) {
    case 'villain':
      return [
        `${w} feasts on momentum — lights out for ${l}.`,
        `Footwork cruel, timing colder. ${w} owns the night.`,
        `Hope? Denied. ${w} signs it in ink.`
      ];
    case 'degen':
      return [
        `${w} prints a W — liquidation fireworks for ${l}!`,
        `Max leverage on timing; ${w} hits green candles.`,
        `${l} got front-run — ${w} sends it.`
      ];
    case 'clean':
      return [
        `${w} takes it with textbook spacing and control.`,
        `Composed, precise — ${w} closes the set.`,
        `Respect shown, skill proven. GG ${l}.`
      ];
    default: // motivator
      return [
        `${w} locks in and **wins it all**!`,
        `Discipline, grit, and clean reads — ${w} delivers.`,
        `GG ${l} — the grind never lies.`
      ];
  }
}

function sanitizeCommentary(raw, { winner, loser, style }) {
  const stripped = stripThinkBlocks(raw || '');
  const lines = safeLinesOnly(stripped, 3, 140)
    .map(s => s.replace(/#[A-Za-z0-9_]+/g, '').trim())
    .filter(Boolean);

  if (lines.length) return lines.join('\n');
  return styleFallbackLines(style, winner, loser).join('\n');
}

/* ========================== Runner (single embed per round with beats) ========================== */
async function runRumbleDisplay({
  channel,
  baseMessage,   // if provided (from slash/prefix), we reuse/edit it to avoid duplicate intro
  challenger,
  opponent,
  bestOf = 3,
  style = (process.env.BATTLE_STYLE_DEFAULT || 'motivator').trim().toLowerCase(),
  guildName = 'this server',
  // allow callers to run their own pre-show
  skipIntro = false,
  envOverride = null
}) {
  bestOf = clampBestOf(bestOf);

  const env = envOverride || chooseEnvironment(channel, ENVIRONMENTS);

  // neutral seed
  const seed = `${channel.id}:${(challenger.id||challenger.user?.id||'A')}:${(opponent.id||opponent.user?.id||'B')}:${Date.now() >> 11}`;
  const sim = simulateBattle({ challenger, opponent, bestOf, style, seed });

  const Aname = challenger.displayName || challenger.username || challenger.user?.username || 'Challenger';
  const Bname = opponent.displayName   || opponent.username   || opponent.user?.username   || 'Opponent';
  const title = `⚔️ Rumble: ${Aname} vs ${Bname}`;

  const mem = makeMemory();
  const stats = { taunts: 0, counters: 0, crits: 0, stuns: 0, combos: 0, events: 0 };
  const roundsTimeline = [];

  // PRELUDE
  let target = channel;
  try {
    if (skipIntro) {
      if (baseMessage && USE_THREAD && baseMessage.startThread) {
        const thread = await baseMessage.startThread({
          name: `${THREAD_NAME}: ${Aname} vs ${Bname}`,
          autoArchiveDuration: 60
        });
        target = thread;
      }
    } else {
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
      await target.send({ embeds: [arenaEmbed(style, env, sim.bestOf)] });
      await sleep(jitter(INTRO_DELAY));
    }
  } catch {
    target = channel;
  }

  // ROUNDS (single embed per round) — progressively edited across beats
  for (let i = 0; i < sim.rounds.length; i++) {
    const r = sim.rounds[i];

    // Build sequence with extra micro moments
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

    // Reveal more beats now that rounds are longer:
    const beatsToReveal = Math.min(seq.length, Math.max(3, ROUND_BEATS + 2));
    const reveal = seq.slice(0, beatsToReveal).map(s => s.content);

    // Initial post for the round
    let preview = coloredBarBlock(Aname, Bname, r.a - (r.winner === Aname ? 1 : 0), r.b - (r.winner === Aname ? 0 : 1), sim.bestOf);
    let msg = await target.send({
      embeds: [roundProgressEmbed(style, i + 1, env, formatFeed(lines), preview)]
    });

    // Reveal each beat with an edit and a pause
    for (let b = 0; b < reveal.length; b++) {
      await sleep(jitter(BEAT_DELAY));
      lines.push(reveal[b]);
      await msg.edit({ embeds: [roundProgressEmbed(style, i + 1, env, formatFeed(lines), '⏳ …resolving round…')] });
    }

    // Finalize the round
    const winnerIsA = r.winner === Aname;
    const prevA = r.a - (winnerIsA ? 1 : 0);
    const prevB = r.b - (winnerIsA ? 0 : 1);
    const wasBehind = winnerIsA ? (prevA < prevB) : (prevB < prevA);

    const roundText = formatFeed(
      lines.concat(seq.slice(beatsToReveal).map(s => s.content))
    ).slice(0, 1800);

    await sleep(jitter(BEAT_DELAY));
    await msg.edit({
      embeds: [roundFinalEmbed(style, i + 1, r, Aname, Bname, sim.bestOf, env, wasBehind, roundText)]
    });

    roundsTimeline.push(`R${i+1}: **${r.winner}** over ${r.loser} (${r.a}-${r.b})`);
    if (i < sim.rounds.length - 1) await sleep(jitter(ROUND_DELAY));
  }

  // FINALE — winner avatar + all-in-one stats
  const champion = sim.a > sim.b ? challenger : opponent;
  const runnerUp = sim.a > sim.b ? opponent  : challenger;
  const championId = (champion.id || champion.user?.id || null);

  // Sanitize commentary
  let cast = null;
  try {
    const raw = await aiCommentary({
      winner: champion.displayName || champion.username || champion.user?.username,
      loser:  runnerUp.displayName || runnerUp.username || runnerUp.user?.username,
      rounds: sim.rounds,
      style,
      guildName
    });
    cast = sanitizeCommentary(raw, {
      winner: champion.displayName || champion.username || champion.user?.username,
      loser:  runnerUp.displayName || runnerUp.username || runnerUp.user?.username,
      style
    }).slice(0, 1024);
  } catch {
    cast = sanitizeCommentary('', {
      winner: champion.displayName || champion.username || champion.user?.username,
      loser:  runnerUp.displayName || runnerUp.user?.username || runnerUp.username,
      style
    }).slice(0, 1024);
  }

  const timeline = roundsTimeline.join(' • ');

  await target.send({
    embeds: [finalAllInOneEmbed({
      style, sim, champion, env, cast, stats, timeline,
      aName: Aname, bName: Bname,
      podium: null
    })]
  });

  if (championId) {
    await target.send({
      content: `🎉 Congratulations <@${championId}>!`,
      allowedMentions: { users: [championId] }
    });
  }

  return { sim, champion };
}

module.exports = { runRumbleDisplay };


