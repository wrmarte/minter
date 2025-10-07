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
// - BATTLE_THUMB_URL: fixed logo image (used for thumbnails or author icon)
// - BATTLE_LOGO_MODE: 'author' (small icon, top-left, default) | 'thumbnail' (top-right)
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
const bold   = (s) => `**${s}**`;

// visual prefix after emoji for each action line
const LINE_PREFIX = '│';
const L = (emoji, text) => `${emoji} ${LINE_PREFIX} ${text}`;

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
      e.thumbnail = { url: BATTLE_THUMB_URL }; // top-right (squeezes width)
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

// Taunts (plain placeholders; we bold during replacement)
const TAUNTS = {
  clean:      [`{A}: "Best self only." {B}: "Always."`,`Respect. Skill. Timing. Go.`,`Gloves up. Form sharp. {A} and {B} nod.`],
  motivator:  [`{A}: "Clock in." {B}: "Clocked." 💪`,`{B}: "We grind clean — no excuse." ⚡`,`Breathe. Focus. Execute.`],
  villain:    [`{A} smiles thinly: "I’ll savor this."`,`Shadows coil as {A} and {B} step forward.`,`{B}: "Hope is a habit I removed."`],
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

/* ========================== Builders ========================== */
function buildTaunt(style, A, B, mem) {
  const bank = TAUNTS[style] || TAUNTS.motivator;
  const line = pickNoRepeat(bank, mem.taunts, 6);
  return L('🗣️', line.replace('{A}', bold(A)).replace('{B}', bold(B)));
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

  return L('🥊', `${bold(A)} grabs a ${w} and ${v} ${bold(B)}!${SFX_STRING()}`);
}
function buildReaction(B) { return L('🛡️', `${bold(B)} ${pick(REACTIONS)}.${SFX_STRING()}`); }
function buildCounter(B) { return L('⚡', `${bold(B)} reads it and flips momentum!${SFX_STRING()}`); }
function buildCrit(attacker) { return L('💥', `${bold(attacker)} lands a **critical** hit!${SFX_STRING()}`); }
function randomEvent(A, B) {
  const roll = Math.random();
  if (roll < HAZARD_CHANCE) return L('⚠️', pick(HAZARDS));
  if (roll < HAZARD_CHANCE + POWERUP_CHANCE) {
    return L('🔸', (pick(POWERUPS)).replace('{X}', Math.random()<0.5 ? bold(A) : bold(B)) + SFX_STRING());
  }
  if (roll < HAZARD_CHANCE + POWERUP_CHANCE + CROWD_CHANCE) return L('📣', pick(CROWD));
  return null;
}
function buildAnnouncer(style) {
  if (ANNOUNCER === 'none') return null;
  const persona = ANNOUNCER_BANK[ANNOUNCER] || ANNOUNCER_BANK.normal;
  if (Math.random() < 0.35 && ANNOUNCER_BANK[style]) return L('🎙️', pick(ANNOUNCER_BANK[style]));
  return L('🎙️', pick(persona));
}

// Scenic line (no-repeat-ish)
function scenicLine(env, mem) {
  const options = [
    L('🎬', pickNoRepeat(CAMERA, mem.scenes, 8)),
    L('🌫️', pickNoRepeat(ATMOS,  mem.scenes, 8)),
    L('🏟️', `${env.name}: ${pickNoRepeat(GROUND, mem.scenes, 8)}`)
  ];
  return pick(options);
}

/* ========================== Colored Bar Helpers (kept for final only) ========================== */
function legendLine(aName, bName, colorA = '🟦', colorB = '🟥') {
  return `Legend: ${colorA} ${aName} • ${colorB} ${bName}`;
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
  return { ...baseEmbed(style, { withLogo: true, allowThumb: true }), title, description: `Rumble incoming…` };
}
function arenaEmbed(style, env, bestOf) {
  const sfx = SFX_STRING();
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: true }), // logo/thumbnail OK here
    title: `🏟️ ARENA REVEAL`,
    description: `📣 **Welcome to ${env.name}**${sfx}\n_${env.intro}_`,
    fields: [{ name: 'Format', value: `Best of **${bestOf}**`, inline: true }],
    footer: { text: `Arena: ${env.name}` }
  };
}

// NOTE: round embeds use NO thumbnail to keep full-width on mobile
function roundProgressEmbed(style, idx, env, linesJoined) {
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: false }), // author icon only; full width
    title: `Round ${idx}`,
    description: linesJoined,
    footer: { text: `Arena: ${env.name}` }
  };
}
function roundFinalEmbed(style, idx, r, env, wasBehind, linesJoined) {
  const color = wasBehind ? 0x2ecc71 /* green */ : colorFor(style);
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: false }), // author icon only; full width
    color,
    title: `Round ${idx} — Result`,
    description: linesJoined,
    fields: [
      { name: 'Winner', value: `**${r.winner}**` },
      // (No loser field per your request)
      { name: 'Round Score', value: `**${r.a}–${r.b}**` },
    ],
    footer: { text: `Style: ${style} • Arena: ${env.name}` }
  };
}

function finalAllInOneEmbed({ style, sim, champion, env, cast, stats, timeline, aName, bName, podium = null }) {
  const name = champion.displayName || champion.username || champion.user?.username || 'Winner';
  const avatar = getAvatarURL(champion);
  const barBlock = coloredBarBlock(bold(aName), bold(bName), sim.a, sim.b, sim.bestOf);

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

  if (Array.isArray(podium) && podium.length) {
    const lines = podium.slice(0,3).map((u, i) => `${i===0?'🥇':i===1?'🥈':'🥉'} ${u}`).join('\n');
    e.fields.push({ name: 'Top 3', value: lines || '—' });
  }
  e.fields.push({ name: '\u200B', value: '\u200B' }); // spacer
  if (cast) e.fields.push({ name: '🎙️ Commentary', value: cast });

  return e;
}

/* ========================== Round Sequence ========================== */
function buildRoundSequence({ A, B, style, mem }) {
  const seq = [];
  if (Math.random() < TAUNT_CHANCE) seq.push({ type: 'taunt', content: buildTaunt(style, A, B, mem) });
  seq.push({ type: 'action', content: buildAction(A, B, style, mem) });

  let stunned = false;
  if (Math.random() < STUN_CHANCE) { seq.push({ type: 'stun', content: L('🫨', `${bold(B)} is briefly stunned!${SFX_STRING()}`) }); stunned = true; }

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
    seq.push({ type: 'combo', content: L('🔁', `Combo x${hits}! ${SFX_STRING()}`) });
  }
  if (Math.random() < EVENTS_CHANCE) {
    const ev = randomEvent(A, B);
    if (ev) seq.push({ type: 'event', content: ev });
  }
  const caster = buildAnnouncer(style);
  if (caster && Math.random() < 0.6) seq.push({ type: 'announcer', content: caster });

  return seq;
}

/* ========================== Commentary sanitize helpers ========================== */
function stripThinkBlocks(text) {
  if (!text) return '';
  let out = String(text);

  // Remove fenced code blocks
  out = out.replace(/```[\s\S]*?```/g, ' ');

  // If any <think|analysis|reasoning|reflection> appears (even unclosed),
  // cut everything from the first tag onward.
  const openIdx = out.search(/<\s*(think|analysis|reasoning|reflection)\b/i);
  if (openIdx !== -1) {
    out = out.slice(0, openIdx);
  }

  // Also remove any stray XML-ish tags of those types
  out = out.replace(/<\s*\/?\s*(think|analysis|reasoning|reflection)[^>]*>/gi, ' ');

  // Remove inline "think:" style prefixes
  out = out.replace(/^\s*(analysis|think|reasoning|reflection)\s*:\s*/gim, '');

  // Drop meta headings (Commentary, Notes) with optional colon
  out = out.replace(/^\s*(commentary|notes?)\s*:?\s*$/gim, '');

  // Remove assistant self-talk lines
  out = out.replace(/^\s*(okay|alright|first,|let'?s|i need to|i should|i will|here'?s)\b.*$/gim, '');

  // Collapse whitespace
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
    .filter(Boolean);

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
  guildName = 'this server'
}) {
  bestOf = clampBestOf(bestOf);

  const env = chooseEnvironment(channel, ENVIRONMENTS);

  // neutral seed (not tied to who clicked the command)
  const seed = `${channel.id}:${(challenger.id||challenger.user?.id||'A')}:${(opponent.id||opponent.user?.id||'B')}:${Date.now() >> 11}`;
  const sim = simulateBattle({ challenger, opponent, bestOf, style, seed });

  const Aname = challenger.displayName || challenger.username || challenger.user?.username || 'Challenger';
  const Bname = opponent.displayName   || opponent.username   || opponent.user?.username   || 'Opponent';
  const title = `⚔️ Rumble: ${Aname} vs ${Bname}`;

  const mem = makeMemory();
  const stats = { taunts: 0, counters: 0, crits: 0, stuns: 0, combos: 0, events: 0 };
  const roundsTimeline = [];

  // PRELUDE — exactly ONE intro
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
    await target.send({ embeds: [arenaEmbed(style, env, sim.bestOf)] });

  } catch {
    target = channel;
    await sleep(jitter(INTRO_DELAY));
    await target.send({ embeds: [arenaEmbed(style, env, sim.bestOf)] }).catch(() => {});
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

    // Start lines with a cinematic opener
    const lines = [];
    lines.push(scenicLine(env, mem));

    const beatsToReveal = Math.max(1, ROUND_BEATS - 1);
    const reveal = seq.slice(0, beatsToReveal).map(s => s.content);

    let msg = await target.send({
      embeds: [roundProgressEmbed(style, i + 1, env, lines.join('\n'))]
    });

    // Reveal each beat with an edit and a pause
    for (let b = 0; b < reveal.length; b++) {
      await sleep(jitter(BEAT_DELAY));
      lines.push(reveal[b]);
      await msg.edit({ embeds: [roundProgressEmbed(style, i + 1, env, lines.join('\n'))] });
    }

    // Finalize the round (replace embed with the result)
    const winnerIsA = r.winner === Aname;
    const prevA = r.a - (winnerIsA ? 1 : 0);
    const prevB = r.b - (winnerIsA ? 0 : 1);
    const wasBehind = winnerIsA ? (prevA < prevB) : (prevB < prevA);

    // Also append any remaining sequence items to the lines
    const roundText = lines.concat(seq.slice(beatsToReveal).map(s => s.content)).join('\n').slice(0, 1800);

    await sleep(jitter(BEAT_DELAY));
    await msg.edit({
      embeds: [roundFinalEmbed(style, i + 1, r, env, wasBehind, roundText)]
    });

    // Timeline note — keep concise for mobile: winner only (+ score)
    roundsTimeline.push(`R${i+1}: **${r.winner}** (${r.a}-${r.b})`);
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

  // Send the final embed first (no mention inside embed title)
  await target.send({
    embeds: [finalAllInOneEmbed({
      style, sim, champion, env, cast, stats, timeline,
      aName: Aname, bName: Bname,
      podium: null
    })]
  });

  // Then post a separate congrats message that pings the winner reliably
  if (championId) {
    await target.send({
      content: `🎉 Congratulations <@${championId}>!`,
      allowedMentions: { users: [championId] }
    });
  }

  return { sim, champion };
}

module.exports = { runRumbleDisplay };



