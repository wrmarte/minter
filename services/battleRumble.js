// services/battleRumble.js
const { simulateBattle, aiCommentary, makeBar, clampBestOf } = require('./battleEngine');

/* ========================== Config ========================== */
const USE_THREAD   = /^true$/i.test(process.env.BATTLE_USE_THREAD || 'true');
const THREAD_NAME  = (process.env.BATTLE_THREAD_NAME || 'Rumble Royale').trim();

const INTRO_DELAY  = Math.max(200, Number(process.env.BATTLE_INTRO_DELAY_MS || 1400));
const ROUND_DELAY  = Math.max(600, Number(process.env.BATTLE_ROUND_DELAY_MS || 5200));
const JITTER_MS    = Math.max(0,   Number(process.env.BATTLE_PACE_JITTER_MS || 1200));

const SAFE_MODE    = !/^false$/i.test(process.env.BATTLE_SAFE_MODE || 'true');
const ANNOUNCER    = (process.env.BATTLE_ANNOUNCER || 'normal').trim().toLowerCase();

// Logo options:
// - BATTLE_THUMB_URL: fixed logo image (used for thumbnails or author icon)
// - BATTLE_LOGO_MODE: 'author' (small icon, top-left, default) | 'thumbnail' (bigger, top-right)
const BATTLE_THUMB_URL = (process.env.BATTLE_THUMB_URL || 'https://iili.io/KnsvEAl.png').trim();
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

function baseEmbed(style, { withLogo = true, allowThumb = true } = {}) {
  const e = {
    color: colorFor(style),
    timestamp: new Date().toISOString()
  };

  // Small logo by default via author icon (top-left)
  if (withLogo && BATTLE_THUMB_URL) {
    if (BATTLE_LOGO_MODE === 'thumbnail' && allowThumb) {
      e.thumbnail = { url: BATTLE_THUMB_URL }; // top-right (cannot size smaller)
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

// no-repeat picker with small memory window
function pickNoRepeat(arr, recent, cap = 6) {
  if (!arr.length) return '';
  let choice = pick(arr), tries = 0;
  while (recent.includes(choice) && tries < 12) { choice = pick(arr); tries++; }
  recent.push(choice);
  if (recent.length > cap) recent.shift();
  return choice;
}
/* Per-match memory (avoids repeats for weapons/verbs/taunts) */
function makeMemory() { return { weapons: [], verbs: [], taunts: [] }; }

/* ========================== Flavor ========================== */
// Arenas
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

// Style-specific weapons/actions
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

/* ========================== Embeds ========================== */
function introEmbed(style, title) {
  return { ...baseEmbed(style, { withLogo: true, allowThumb: true }), title, description: `Rumble incoming…` };
}
function arenaEmbed(style, env, bestOf) {
  const sfx = SFX_STRING();
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: true }),
    title: `🏟️ ARENA REVEAL`,
    description: `📣 **Welcome to ${env.name}!**${sfx}\n_${env.intro}_`,
    fields: [{ name: 'Format', value: `Best of **${bestOf}**`, inline: true }],
    footer: { text: `Arena: ${env.name}` }
  };
}
// color green if winner was trailing before this round (comeback)
function roundEmbed(style, idx, r, bar, bestOf, env, wasBehind, roundText) {
  const color = wasBehind ? 0x2ecc71 /* green */ : colorFor(style);
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: true }),
    color,
    title: `Round ${idx} — Fight & Result`,
    description: `${roundText}\n\n${bar}`,
    fields: [
      { name: 'Winner', value: `**${r.winner}**`, inline: true },
      { name: 'Loser',  value: `${r.loser}`, inline: true },
      { name: 'Score',  value: `**${r.a}–${r.b}** (Bo${bestOf})`, inline: true },
    ],
    footer: { text: `Style: ${style} • Arena: ${env.name}` }
  };
}
function finalAllInOneEmbed({ style, sim, champion, bar, env, cast, stats, timeline }) {
  const name = champion.displayName || champion.username || champion.user?.username || 'Winner';
  const avatar = getAvatarURL(champion);
  const e = {
    ...baseEmbed(style, { withLogo: false, allowThumb: false }), // NO fixed logo on final
    title: `🏆 Final — ${name} wins ${sim.a}-${sim.b}!`,
    description: bar,
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

/* ========================== Runner (single intro; single embed per round) ========================== */
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
  const env = pick(ENVIRONMENTS);
  // neutral seed (not tied to who clicked the command)
  const seed = `${channel.id}:${(challenger.id||challenger.user?.id||'A')}:${(opponent.id||opponent.user?.id||'B')}:${Date.now() >> 11}`;
  const sim = simulateBattle({ challenger, opponent, bestOf, style, seed });

  const Aname = challenger.displayName || challenger.username || challenger.user?.username || 'Challenger';
  const Bname = opponent.displayName   || opponent.username   || opponent.user?.username   || 'Opponent';
  const title = `⚔️ Rumble: ${Aname} vs ${Bname}`;

  // Per-match memory to reduce repeats
  const mem = makeMemory();

  // Stats accumulator (display-only)
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

  // ROUNDS (single embed per round)
  for (let i = 0; i < sim.rounds.length; i++) {
    const r = sim.rounds[i];
    const bar = makeBar(r.a, r.b, sim.bestOf);

    // Build a sequence of lines for this round, then aggregate into a single embed
    const seq = buildRoundSequence({ A: r.winner, B: r.loser, style, mem });

    for (const step of seq) {
      if (step.type === 'taunt')   stats.taunts++;
      if (step.type === 'counter') stats.counters++;
      if (step.type === 'crit')    stats.crits++;
      if (step.type === 'stun')    stats.stuns++;
      if (step.type === 'combo')   stats.combos++;
      if (step.type === 'event')   stats.events++;
    }

    const roundText = seq.map(s => s.content).join('\n');

    // comeback detection (winner was behind before this round)
    const winnerIsA = r.winner === Aname;
    const prevA = r.a - (winnerIsA ? 1 : 0);
    const prevB = r.b - (winnerIsA ? 0 : 1);
    const wasBehind = winnerIsA ? (prevA < prevB) : (prevB < prevA);

    const embed = roundEmbed(style, i + 1, r, bar, sim.bestOf, env, wasBehind, roundText);
    await target.send({ embeds: [embed] });

    roundsTimeline.push(`R${i+1}: **${r.winner}** over ${r.loser} (${r.a}-${r.b})`);

    if (i < sim.rounds.length - 1) await sleep(jitter(ROUND_DELAY));
  }

  // FINALE — winner avatar + all-in-one stats (NO fixed logo here)
  const champion = sim.a > sim.b ? challenger : opponent;
  const runnerUp = sim.a > sim.b ? opponent  : challenger;
  const finalBar = makeBar(sim.a, sim.b, sim.bestOf);

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
    style, sim, champion, bar: finalBar, env, cast, stats, timeline
  })] });

  return { sim, champion };
}

module.exports = { runRumbleDisplay };




