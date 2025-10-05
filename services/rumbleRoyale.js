// services/rumbleRoyale.js
const { simulateBattle, aiCommentary, clampBestOf } = require('./battleEngine');

/* ===== Config (reusing your battleRumble knobs) ===== */
const USE_THREAD   = /^true$/i.test(process.env.BATTLE_USE_THREAD || 'true');
const THREAD_NAME  = (process.env.BATTLE_THREAD_NAME || 'Rumble Royale').trim();

const INTRO_DELAY  = Math.max(200, Number(process.env.BATTLE_INTRO_DELAY_MS || 1400));
const ROUND_DELAY  = Math.max(600, Number(process.env.BATTLE_ROUND_DELAY_MS || 5200));
const BEAT_DELAY   = Math.max(400, Number(process.env.BATTLE_BEAT_DELAY_MS || '1800'));
const JITTER_MS    = Math.max(0,   Number(process.env.BATTLE_PACE_JITTER_MS || 1200));
const SAFE_MODE    = !/^false$/i.test(process.env.BATTLE_SAFE_MODE || 'true');
const ANNOUNCER    = (process.env.BATTLE_ANNOUNCER || 'normal').trim().toLowerCase();

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

const ROYALE_BESTOF  = clampBestOf(Number(process.env.BATTLE_ROYALE_BESTOF || 1)); // 1 by default (fast skirmish)

function clamp01(x){ x = Number(x); if (!isFinite(x)) return 0; return Math.min(1, Math.max(0, x)); }
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (base) => base + Math.floor((Math.random() * 2 - 1) * JITTER_MS);
const pick   = (arr) => arr[Math.floor(Math.random() * arr.length)];

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
  if (withLogo && BATTLE_THUMB_URL) {
    if (BATTLE_LOGO_MODE === 'thumbnail' && allowThumb) {
      e.thumbnail = { url: BATTLE_THUMB_URL }; // top-right logo
      e.author = { name: 'Rumble Royale' };
    } else {
      e.author = { name: 'Rumble Royale', icon_url: BATTLE_THUMB_URL }; // small author icon, top-left
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

const CAMERA = ['Camera pans low past bootlaces.','Drone swoops between the fighters.','Spotlights skate across the floor.','Jumbotron flickers to life.','Ref’s hand hovers… and drops.'];
const ATMOS  = ['Crowd hushes to a sharp inhale.','Bassline rattles the rails.','Cold wind threads the arena.','Mist rolls in from the corners.','Neon buzz rises, then stills.'];
const GROUND = ['Dust kicks up around their feet.','Confetti shimmers in a slow fall.','Cables hum under the catwalk.','Sand grinds under heel turns.','Tiles thrum like a heartbeat.'];

const SFX = ['💥','⚡','🔥','✨','💫','🫨','🌪️','🎯','🧨','🥁','📣','🔊'];
const SFX_STRING = () => SFX_ON ? ' ' + Array.from({length: 2 + Math.floor(Math.random()*3)}, () => pick(SFX)).join('') : '';

const TAUNTS = {
  clean:      [`Gloves up. Form sharp. {A} and {B} nod.`,`{A}: "Best self only." {B}: "Always."`,`Respect. Skill. Timing. Go.`],
  motivator:  [`{A}: "Clock in." {B}: "Clocked." 💪`,`{B}: "We grind clean — no excuse." ⚡`,`Breathe. Focus. Execute.`],
  villain:    [`{A}: "I’ll savor this." {B} smiles thinly.`,`Shadows coil as {A} and {B} step forward.`,`{B}: "Hope is a habit I removed."`],
  degen:      [`{A}: "Max leverage." {B}: "Full send." 🚀`,`Slippage set to chaos — {A} vs {B}.`,`{B}: "Prints only. No stops."`]
};

const W_CLEAN_SAFE = ['dojo staff','bamboo shinai','practice pads','mirror shield','focus band','training mitts'];
const W_MOTI_SAFE  = ['PR belt','chalk cloud','coach whistle','rep rope','foam mace','discipline dumbbell'];
const W_VILL_SAFE  = ['shadow ribbon','smoke dagger (prop)','echo bell','trick tarot','void tether (cosplay)'];
const W_DEGN_SAFE  = ['alpha baton','yield yo-yo','pump trumpet','airdrop crate','ape gauntlet','vibe ledger'];
const WEAPONS_SAFE = ['foam bat','rubber chicken','pool noodle','pixel sword','ban hammer','yo-yo','cardboard shield','toy bo staff','glitch gauntlet'];

const W_CLEAN_SPICY= ['weighted baton (prop)','tempered shinai (spar)'];
const W_MOTI_SPICY = ['iron plate (prop)','slam ball (soft)'];
const W_VILL_SPICY = ['hex blade (prop)','cursed grimoire (cosplay)'];
const W_DEGN_SPICY = ['leverage gloves','moon mallet (prop)'];
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
function buildTaunt(style, A, B) {
  const bank = TAUNTS[style] || TAUNTS.motivator;
  const line = bank[Math.floor(Math.random()*bank.length)];
  return `🗣️ ${line.replace('{A}', A).replace('{B}', B)}`;
}
function buildAction(A, B, style) {
  const w = pick(styleWeapons(style));
  const v = pick(styleVerbs(style));
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
function scenicLine() {
  const a = pick(CAMERA), b = pick(ATMOS), c = pick(GROUND);
  return pick([`🎬 ${a}`, `🌫️ ${b}`, `🏟️ ${c}`]);
}

/* ===== Embeds (skirmish-only + final) ===== */
function skirmishEmbed(style, title, linesJoined) {
  return {
    ...baseEmbed(style, { withLogo: true, allowThumb: true }),
    title,
    description: linesJoined
  };
}

function nameOf(m) {
  return m?.displayName || m?.user?.username || m?.username || '—';
}

function sanitizeAI(s) {
  if (!s) return null;
  let t = String(s);
  // strip think tags or similar
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/```[\s\S]*?```/g, '');
  return t.trim();
}

function finalEmbed({ style, champion, runnerUp, third, guildName, cast }) {
  const champName = nameOf(champion);
  const runName   = nameOf(runnerUp);
  const thirdName = third ? nameOf(third) : null;
  const avatar    = getAvatarURL(champion);

  const placementsLines = [
    `🥇 ${champName}`,
    `🥈 ${runName}`,
    thirdName ? `🥉 ${thirdName}` : null
  ].filter(Boolean).join('\n');

  const e = {
    ...baseEmbed(style, { withLogo: false, allowThumb: false }), // no fixed logo on final
    title: `🏆 Royale Champion — ${champName}`,
    description: `Runner-up: **${runName}**`,
    thumbnail: avatar ? { url: avatar } : undefined,
    fields: [
      { name: 'Top 3', value: placementsLines || '—' }
    ],
    footer: { text: `${guildName} • Battle Royale` }
  };

  const cleanCast = sanitizeAI(cast);
  if (cleanCast) e.fields.push({ name: '🎙️ Commentary', value: cleanCast.slice(0, 1024) });

  return e;
}

/* ===== Round sequence (like battleRumble, but skirmish compact) ===== */
function buildSkirmishSequence(A, B, style) {
  const seq = [];
  if (Math.random() < TAUNTS) seq.push({ type: 'taunt', content: buildTaunt(style, A, B) }); // NOTE: small typo fix: TAUNTS isn't prob here; keep original logic:
  // Keeping original logic (don’t mess): use TAUNT_CHANCE
  seq.length = 0;
  if (Math.random() < TAUNT_CHANCE) seq.push({ type: 'taunt', content: buildTaunt(style, A, B) });
  seq.push({ type: 'action', content: buildAction(A, B, style) });

  let stunned = false;
  if (Math.random() < STUN_CHANCE) { seq.push({ type: 'stun', content: `🫨 ${B} is briefly stunned!${SFX_STRING()}` }); stunned = true; }

  if (!stunned) {
    if (Math.random() < COUNTER_CHANCE) seq.push({ type: 'counter', content: buildCounter(B) });
    else seq.push({ type: 'reaction', content: buildReaction(B) });
  }
  if (Math.random() < CRIT_CHANCE) {
    const lastWasCounter = seq.some(s => s.type === 'counter');
    seq.push({ type: 'crit', content: buildCrit(lastWasCounter ? B : A) });
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

/* ===== Main Runner: Battle Royale ===== */
async function runRoyaleRumble({
  channel,
  baseMessage,            // re-used to avoid double intro
  fighters,               // array of GuildMembers
  style = (process.env.BATTLE_STYLE_DEFAULT || 'motivator').trim().toLowerCase(),
  guildName = 'this server'
}) {
  const alive = fighters.slice();
  const placements = [];         // losers unshifted -> [runner-up, third, ...]
  // INTRO (once)
  let target = channel;
  try {
    if (baseMessage) {
      await baseMessage.edit({
        embeds: [{
          ...baseEmbed(style, { withLogo: true, allowThumb: true }),
          title: '🎲 Battle Royale — Skirmishes Incoming',
          description: 'Fighters spread out across the arena…'
        }]
      }).catch(() => {});
      if (USE_THREAD && baseMessage.startThread) {
        const thread = await baseMessage.startThread({ name: THREAD_NAME, autoArchiveDuration: 60 });
        target = thread;
      }
    } else {
      const intro = await channel.send({
        embeds: [{
          ...baseEmbed(style, { withLogo: true, allowThumb: true }),
          title: '🎲 Battle Royale — Skirmishes Incoming',
          description: 'Fighters spread out across the arena…'
        }]
      });
      if (USE_THREAD && intro?.startThread) {
        const thread = await intro.startThread({ name: THREAD_NAME, autoArchiveDuration: 60 });
        target = thread;
      }
    }
  } catch {}

  await sleep(jitter(INTRO_DELAY));

  // LOOP skirmishes until one remains
  let sk = 0;
  while (alive.length > 1) {
    sk++;
    const iA = Math.floor(Math.random() * alive.length);
    let iB = Math.floor(Math.random() * alive.length);
    while (iB === iA) iB = Math.floor(Math.random() * alive.length);

    const A = alive[iA];
    const B = alive[iB];
    const Aname = nameOf(A);
    const Bname = nameOf(B);

    const seed = `${channel.id}:${A.id}:${B.id}:${Date.now() >> 11}`;
    const sim   = simulateBattle({ challenger: A, opponent: B, bestOf: ROYALE_BESTOF, style, seed });

    const title = `Skirmish ${sk} — ${Aname} vs ${Bname}`;
    const lines = [scenicLine()];
    const seq   = buildSkirmishSequence(sim.rounds[0].winner, sim.rounds[0].loser, style);

    let msg = await target.send({ embeds: [skirmishEmbed(style, title, lines.join('\n'))] });
    await sleep(jitter(BEAT_DELAY));

    for (const s of seq) {
      lines.push(s.content);
      await msg.edit({ embeds: [skirmishEmbed(style, title, lines.join('\n'))] });
      await sleep(jitter(Math.max(300, BEAT_DELAY - 300)));
    }

    const loser  = (sim.a > sim.b) ? B : A;
    lines.push(`\n💀 **${nameOf(loser)} is eliminated!**`);
    await msg.edit({ embeds: [skirmishEmbed(style, title, lines.join('\n'))] });

    // remove loser, store for placements
    placements.unshift(loser);
    const idx = alive.findIndex(m => m.id === loser.id);
    if (idx >= 0) alive.splice(idx, 1);

    if (alive.length > 1) await sleep(jitter(ROUND_DELAY));
  }

  // champion, runner-up, third
  const champion = alive[0];
  const runnerUp = placements[0];
  const third    = placements[1] || null;

  // Optional AI commentary — SAFE: sanitize + embed field
  let cast = null;
  try {
    cast = await aiCommentary({
      winner: nameOf(champion),
      loser:  nameOf(runnerUp),
      rounds: [],
      style,
      guildName
    });
  } catch {}

  // Final embed WITHIN embed (no extra message), Top 3 only
  await target.send({
    embeds: [finalEmbed({
      style,
      champion,
      runnerUp,
      third,
      guildName,
      cast
    })]
  });

  return { champion, runnerUp, third };
}

module.exports = { runRoyaleRumble };

