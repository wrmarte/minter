// listeners/mbella.js
const fetch = require('node-fetch');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');

/** ================= ENV & CONFIG ================= */
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL_ENV = (process.env.GROQ_MODEL || '').trim();

// Display config
const MBELLA_NAME = (process.env.MBELLA_NAME || 'MBella').trim();
// ⚠️ Use a DIRECT image URL (not an HTML page), e.g. https://iili.io/KnsvEAl.png
const MBELLA_AVATAR_URL = (process.env.MBELLA_AVATAR_URL || '').trim();

// Webhook discovery name (manual webhook must match this to be reused)
const MB_RELAY_WEBHOOK_NAME = (process.env.MB_RELAY_WEBHOOK_NAME || 'MB Relay').trim();

// Debug
const DEBUG = String(process.env.WEBHOOKAUTO_DEBUG || '').trim() === '1';

// ===== Spice controls (optional envs) =====
// MBELLA_SPICE: pg13 | r | feral   (default: r)
const MBELLA_SPICE = String(process.env.MBELLA_SPICE || 'r').trim().toLowerCase();
// Hard cap: never explicit. This just tunes profanity/innuendo/chaos.
const MBELLA_ALLOW_PROFANITY = String(process.env.MBELLA_ALLOW_PROFANITY || '1').trim() === '1';

// ===== NEW: Human / God mode controls =====
// MBELLA_HUMAN_LEVEL: 0..3 (default 2) => 0 = robotic, 3 = most human
const MBELLA_HUMAN_LEVEL_DEFAULT = Math.max(0, Math.min(3, Number(process.env.MBELLA_HUMAN_LEVEL || 2)));

// MBELLA_CURSE_RATE: 0..1 (default depends on spice). This is "permission to swear lightly sometimes".
const MBELLA_CURSE_RATE_ENV = process.env.MBELLA_CURSE_RATE;
const MBELLA_CURSE_RATE_DEFAULT = (() => {
  if (MBELLA_CURSE_RATE_ENV != null && MBELLA_CURSE_RATE_ENV !== '') {
    const n = Number(MBELLA_CURSE_RATE_ENV);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  if (MBELLA_SPICE === 'pg13') return 0.05;
  if (MBELLA_SPICE === 'feral') return 0.28;
  return 0.16; // r
})();

// MBELLA_GOD_DEFAULT: 1 to default god mode ON for owner/admin (still toggleable)
const MBELLA_GOD_DEFAULT = String(process.env.MBELLA_GOD_DEFAULT || '0').trim() === '1';
// How long a chat-toggle stays active per guild
const MBELLA_GOD_TTL_MS = Number(process.env.MBELLA_GOD_TTL_MS || (30 * 60 * 1000)); // 30 min
const MBELLA_HUMAN_TTL_MS = Number(process.env.MBELLA_HUMAN_TTL_MS || (60 * 60 * 1000)); // 60 min
const MBELLA_MEM_TTL_MS = Number(process.env.MBELLA_MEM_TTL_MS || (45 * 60 * 1000)); // 45 min

// Pace (match MuscleMB by default)
const MBELLA_MS_PER_CHAR = Number(process.env.MBELLA_MS_PER_CHAR || '40');     // 40ms/char
const MBELLA_MAX_DELAY_MS = Number(process.env.MBELLA_MAX_DELAY_MS || '5000'); // 5s cap
const MBELLA_DELAY_OFFSET_MS = Number(process.env.MBELLA_DELAY_OFFSET_MS || '150'); // small “land after thinking” offset

// Simulated typing: create a webhook placeholder only if LLM is slow
const MBELLA_TYPING_DEBOUNCE_MS = Number(process.env.MBELLA_TYPING_DEBOUNCE_MS || '1200');

// Ensure MBella sends only after at least this many ms have passed since main-bot sendTyping()
const MBELLA_TYPING_TARGET_MS = Number(process.env.MBELLA_TYPING_TARGET_MS || '9200'); // ~9.2s

// Behavior config
const COOLDOWN_MS = 10_000;
const FEMALE_TRIGGERS = ['mbella', 'mb ella', 'lady mb', 'queen mb', 'bella'];
const RELEASE_REGEX = /\b(stop|bye bella|goodbye bella|end chat|silence bella)\b/i;

// ===== NEW: Owner/admin toggles (chat phrases) =====
const GOD_ON_REGEX = /\b(bella\s+god\s+on|bella\s+godmode\s+on|god\s+mode\s+bella\s+on)\b/i;
const GOD_OFF_REGEX = /\b(bella\s+god\s+off|bella\s+godmode\s+off|god\s+mode\s+bella\s+off)\b/i;
const HUMAN_SET_REGEX = /\b(bella\s+human\s+([0-3]))\b/i;
const CURSE_ON_REGEX = /\b(bella\s+curse\s+on|bella\s+swear\s+on)\b/i;
const CURSE_OFF_REGEX = /\b(bella\s+curse\s+off|bella\s+swear\s+off)\b/i;

/** Guard rail */
if (!GROQ_API_KEY || GROQ_API_KEY.trim().length < 10) {
  console.warn('⚠️ GROQ_API_KEY missing/short for MBella. Check your env.');
}

/** ================== STATE ================== */
const cooldown = new Set();

function alreadyHandled(client, messageId) {
  if (!client.__mbHandled) client.__mbHandled = new Set();
  return client.__mbHandled.has(messageId);
}
function markHandled(client, messageId) {
  if (!client.__mbHandled) client.__mbHandled = new Set();
  client.__mbHandled.add(messageId);
  setTimeout(() => client.__mbHandled.delete(messageId), 60_000);
}

// "current partner" cache
const BELLA_TTL_MS = 30 * 60 * 1000; // 30 mins
const bellaPartners = new Map(); // channelId -> { userId, expiresAt }
function setBellaPartner(channelId, userId, ttlMs = BELLA_TTL_MS) {
  bellaPartners.set(channelId, { userId, expiresAt: Date.now() + ttlMs });
}
function getBellaPartner(channelId) {
  const rec = bellaPartners.get(channelId);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) { bellaPartners.delete(channelId); return null; }
  return rec.userId;
}
function clearBellaPartner(channelId) { bellaPartners.delete(channelId); }

// 🔕 Cross-listener typing suppression (read/write shared map on client)
function setTypingSuppress(client, channelId, ms = 12000) {
  if (!client.__mbTypingSuppress) client.__mbTypingSuppress = new Map();
  const until = Date.now() + ms;
  client.__mbTypingSuppress.set(channelId, until);
  setTimeout(() => {
    const exp = client.__mbTypingSuppress.get(channelId);
    if (exp && exp <= Date.now()) client.__mbTypingSuppress.delete(channelId);
  }, ms + 500);
}

// ===== NEW: per-guild settings (god/human/cursing) with TTL =====
const bellaGuildState = new Map(); // guildId -> { god: {on, exp}, human: {level, exp}, curse: {on, exp} }

function _getGuildState(guildId) {
  if (!bellaGuildState.has(guildId)) {
    bellaGuildState.set(guildId, {
      god: { on: MBELLA_GOD_DEFAULT, exp: 0 },
      human: { level: MBELLA_HUMAN_LEVEL_DEFAULT, exp: 0 },
      curse: { on: MBELLA_ALLOW_PROFANITY, exp: 0 }
    });
  }
  const st = bellaGuildState.get(guildId);

  // expire
  const now = Date.now();
  if (st.god.exp && now > st.god.exp) { st.god.on = MBELLA_GOD_DEFAULT; st.god.exp = 0; }
  if (st.human.exp && now > st.human.exp) { st.human.level = MBELLA_HUMAN_LEVEL_DEFAULT; st.human.exp = 0; }
  if (st.curse.exp && now > st.curse.exp) { st.curse.on = MBELLA_ALLOW_PROFANITY; st.curse.exp = 0; }

  return st;
}

function _setGod(guildId, on) {
  const st = _getGuildState(guildId);
  st.god.on = Boolean(on);
  st.god.exp = Date.now() + MBELLA_GOD_TTL_MS;
}
function _setHuman(guildId, level) {
  const st = _getGuildState(guildId);
  st.human.level = Math.max(0, Math.min(3, Number(level)));
  st.human.exp = Date.now() + MBELLA_HUMAN_TTL_MS;
}
function _setCurse(guildId, on) {
  const st = _getGuildState(guildId);
  st.curse.on = Boolean(on);
  st.curse.exp = Date.now() + MBELLA_HUMAN_TTL_MS;
}

// ===== NEW: in-memory convo “memory” per channel =====
const bellaMemory = new Map(); // channelId -> { exp, items: [{role:'user'|'bella', text, ts}] }

function pushMemory(channelId, role, text) {
  const now = Date.now();
  const rec = bellaMemory.get(channelId) || { exp: now + MBELLA_MEM_TTL_MS, items: [] };
  rec.exp = now + MBELLA_MEM_TTL_MS;
  rec.items.push({ role, text: String(text || '').trim().slice(0, 600), ts: now });
  // keep last 10
  if (rec.items.length > 10) rec.items = rec.items.slice(rec.items.length - 10);
  bellaMemory.set(channelId, rec);
}

function getMemoryContext(channelId) {
  const rec = bellaMemory.get(channelId);
  if (!rec) return '';
  if (Date.now() > rec.exp) { bellaMemory.delete(channelId); return ''; }
  const lines = rec.items
    .filter(x => x.text)
    .slice(-8)
    .map(x => (x.role === 'bella' ? `MBella: ${x.text}` : `User: ${x.text}`));
  if (!lines.length) return '';
  return `Channel memory (recent turns, keep consistent tone & facts):\n${lines.join('\n')}`.slice(0, 1200);
}

/** ================== UTILS ================== */
function safeJsonParse(text) { try { return JSON.parse(text); } catch { return null; } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = () => Math.random();
function chance(p) { return rand() < Math.max(0, Math.min(1, p)); }

function isOwnerOrAdmin(message) {
  try {
    const ownerId = String(process.env.BOT_OWNER_ID || '').trim();
    const isOwner = ownerId && message.author?.id === ownerId;
    const isAdmin = Boolean(message.member?.permissions?.has(PermissionsBitField.Flags.Administrator));
    return isOwner || isAdmin;
  } catch {
    return false;
  }
}

// Light “intensity” detector (for when to allow swearing / more human vibe)
function computeIntensityScore(text) {
  const t = String(text || '');
  let score = 0;
  if (/[A-Z]{5,}/.test(t)) score += 1;               // CAPS bursts
  if ((t.match(/!/g) || []).length >= 3) score += 1; // excitement
  if ((t.match(/\?/g) || []).length >= 3) score += 1; // agitation
  if (/\b(fuck|shit|damn|hell|wtf|lmao|lmfao)\b/i.test(t)) score += 1;
  if (/\b(angry|mad|pissed|annoyed|rage|crash|broken|fix now|urgent)\b/i.test(t)) score += 1;
  if (/\b(love|miss|baby|babe|hot|sexy|flirt)\b/i.test(t)) score += 1;
  return Math.min(5, score);
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 25_000) {
  const hasAbort = typeof globalThis.AbortController === 'function';
  if (hasAbort) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      const bodyText = await res.text();
      return { res, bodyText };
    } finally { clearTimeout(timer); }
  } else {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, opts);
        const bodyText = await res.text();
        return { res, bodyText };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeoutMs))
    ]);
  }
}

function preferOrder(a, b) {
  const size = (id) => { const m = id.match(/(\d+)\s*b|\b(\d+)[bB]\b|-(\d+)b/); return m ? parseInt(m[1] || m[2] || m[3] || '0', 10) : 0; };
  const ver  = (id) => { const m = id.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const szDiff = size(b) - size(a);
  if (szDiff) return szDiff;
  return ver(b) - ver(a);
}

/** ================== GROQ MODEL DISCOVERY ================== */
let MODEL_CACHE = { ts: 0, models: [] };
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;

async function fetchGroqModels() {
  try {
    const { res, bodyText } = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/models',
      { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` } },
      20_000
    );
    if (!res.ok) {
      console.error(`❌ Groq /models HTTP ${res.status}: ${bodyText?.slice(0, 300)}`);
      return [];
    }
    const data = safeJsonParse(bodyText);
    if (!data || !Array.isArray(data.data)) return [];
    const ids = data.data.map(x => x.id).filter(Boolean);
    const chatLikely = ids.filter(id => /llama|mixtral|gemma|qwen|deepseek/i.test(id)).sort(preferOrder);
    return chatLikely.length ? chatLikely : ids.sort(preferOrder);
  } catch (e) {
    console.error('❌ Failed to list Groq models:', e.message);
    return [];
  }
}

async function getModelsToTry() {
  const list = [];
  if (GROQ_MODEL_ENV) list.push(GROQ_MODEL_ENV);
  const now = Date.now();
  if (!MODEL_CACHE.models.length || (now - MODEL_CACHE.ts) > MODEL_TTL_MS) {
    const models = await fetchGroqModels();
    if (models.length) MODEL_CACHE = { ts: now, models };
  }
  for (const id of MODEL_CACHE.models) if (!list.includes(id)) list.push(id);
  return list;
}

function buildGroqBody(model, systemPrompt, userContent, temperature, maxTokens = 200) {
  const cleanUser = String(userContent || '').slice(0, 4000);
  return JSON.stringify({
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: cleanUser },
    ],
  });
}

async function groqTryModel(model, systemPrompt, userContent, temperature, maxTokens) {
  const { res, bodyText } = await fetchWithTimeout(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: buildGroqBody(model, systemPrompt, userContent, temperature, maxTokens),
    },
    25_000
  );
  return { res, bodyText };
}

async function groqWithDiscovery(systemPrompt, userContent, temperature, maxTokens = 200) {
  if (!GROQ_API_KEY || GROQ_API_KEY.trim().length < 10) return { error: new Error('Missing GROQ_API_KEY') };
  const models = await getModelsToTry();
  if (!models.length) return { error: new Error('No Groq models available') };

  let last = null;
  for (const m of models) {
    try {
      const r = await groqTryModel(m, systemPrompt, userContent, temperature, maxTokens);
      if (!r.res.ok) {
        console.error(`❌ Groq (MBella) HTTP ${r.res.status} on model "${m}": ${r.bodyText?.slice(0, 400)}`);
        if (r.res.status === 400 || r.res.status === 404) { last = { model: m, ...r }; continue; }
        return { model: m, ...r };
      }
      return { model: m, ...r };
    } catch (e) {
      console.error(`❌ Groq (MBella) fetch error on model "${m}":`, e.message);
      last = { model: m, error: e };
    }
  }
  return last || { error: new Error('All models failed') };
}

/** ================== DISCORD HELPERS ================== */
async function getRecentContext(message) {
  try {
    const fetched = await message.channel.messages.fetch({ limit: 12 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.id === message.id) continue;
      if (m.author?.bot) continue;
      const txt = (m.content || '').trim();
      if (!txt) continue;
      const oneLine = txt.replace(/\s+/g, ' ').slice(0, 220);
      lines.push(`${m.author.username}: ${oneLine}`);
      if (lines.length >= 8) break;
    }
    if (!lines.length) return '';
    return `Recent context:\n${lines.join('\n')}`.slice(0, 1400);
  } catch { return ''; }
}

async function getReferenceSnippet(message) {
  const ref = message.reference;
  if (!ref?.messageId) return '';
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);
    const txt = (referenced?.content || '').replace(/\s+/g, ' ').trim().slice(0, 260);
    if (!txt) return '';
    return `You are replying to ${referenced.author?.username || 'someone'}: "${txt}"`;
  } catch { return ''; }
}

function canSendInChannel(guild, channel) {
  const me = guild.members.me;
  if (!me || !channel) return false;
  return channel.isTextBased?.() && channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);
}

/** ===== Use shared webhookAuto from index.js (client.webhookAuto) ===== */
async function getBellaWebhook(client, channel) {
  try {
    const wa = client?.webhookAuto;
    if (!wa || typeof wa.getOrCreateWebhook !== 'function') {
      if (DEBUG) console.log('[MBella] client.webhookAuto missing. (Did you patch index.js?)');
      return null;
    }
    const hook = await wa.getOrCreateWebhook(channel, {
      name: MB_RELAY_WEBHOOK_NAME,
      avatarURL: MBELLA_AVATAR_URL || null
    });
    if (!hook && DEBUG) {
      const me = channel?.guild?.members?.me;
      const perms = (me && channel?.permissionsFor?.(me)) ? channel.permissionsFor(me) : null;
      const hasMW = perms?.has(PermissionsBitField.Flags.ManageWebhooks);
      console.log(`[MBella] No webhook returned. ManageWebhooks=${hasMW ? 'YES' : 'NO'} channel=${channel?.id} guild=${channel?.guild?.id}`);
    }
    return hook || null;
  } catch (e) {
    if (DEBUG) console.log('[MBella] getBellaWebhook failed:', e?.message || e);
    return null;
  }
}

async function sendViaBellaWebhook(client, channel, { username, avatarURL, embeds, content }) {
  const hook = await getBellaWebhook(client, channel);
  if (!hook) return { hook: null, message: null };
  try {
    const message = await hook.send({
      username: username || MBELLA_NAME,
      avatarURL: (avatarURL || MBELLA_AVATAR_URL || undefined),
      embeds,
      content,
      allowedMentions: { parse: [] },
    });
    return { hook, message };
  } catch (e) {
    if (DEBUG) console.log('[MBella] webhook send failed:', e?.message || e);
    try { client.webhookAuto?.clearChannelCache?.(channel.id); } catch {}
    return { hook, message: null };
  }
}

/** detect if this message is a reply to MBella (webhook or fallback) */
async function isReplyToMBella(message, client) {
  const ref = message.reference;
  if (!ref?.messageId) return false;
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);

    if (referenced.webhookId) {
      if (referenced.author?.username && referenced.author.username.toLowerCase() === MBELLA_NAME.toLowerCase()) {
        return true;
      }
      if (referenced.author?.username && referenced.author.username.toLowerCase() === MB_RELAY_WEBHOOK_NAME.toLowerCase()) {
        return true;
      }
    }

    if (referenced.author?.id === client.user.id) {
      const embedAuthor = referenced.embeds?.[0]?.author?.name || '';
      if (embedAuthor.toLowerCase() === MBELLA_NAME.toLowerCase()) return true;
    }
  } catch {}
  return false;
}

/** ================== MBELLA STYLE PROMPT (HUMAN / SWEAR / GOD MODE) ================== */
function buildMBellaSystemPrompt({
  isRoast,
  isRoastingBot,
  roastTargets,
  currentMode,
  recentContext,
  memoryContext,
  humanLevel,
  curseAllowedNow,
  curseRate,
  intensity,
  godMode
}) {
  // Spice tiers (still non-explicit)
  const spiceDeck = (() => {
    if (MBELLA_SPICE === 'pg13') {
      return [
        'Spice: PG-13 flirt + playful chaos, minimal profanity.',
        'No explicit sexual content. Keep it cute, teasing, and classy.'
      ].join(' ');
    }
    if (MBELLA_SPICE === 'feral') {
      return [
        'Spice: FERAL R-rated energy — wild degen humor, bold flirt, spicy innuendo.',
        'Profanity allowed (no slurs). Still NO explicit sexual content or graphic descriptions.'
      ].join(' ');
    }
    // default: r
    return [
      'Spice: R-rated energy — adult humor, bold flirt, spicy innuendo.',
      'Profanity allowed (no slurs). Still NO explicit sexual content or graphic descriptions.'
    ].join(' ');
  })();

  const humanDeck = (() => {
    if (humanLevel <= 0) {
      return [
        'Humanity: low. Keep responses clean and direct.',
        'Avoid slang. Avoid filler words.'
      ].join(' ');
    }
    if (humanLevel === 1) {
      return [
        'Humanity: medium. Use natural speech, contractions, light humor.',
        'Occasional short interjections like “mm”, “okay okay”, “nah”, but keep it readable.'
      ].join(' ');
    }
    if (humanLevel === 2) {
      return [
        'Humanity: high. Sound like a real person in chat.',
        'Use casual rhythm, small personality quirks, playful phrasing, and confident warmth.',
        'Never say “as an AI”. Don’t sound robotic.'
      ].join(' ');
    }
    // 3
    return [
      'Humanity: MAX. Be extremely human-like: subtle sass, tiny imperfections (rare), playful cadence.',
      'Use short punchy lines, occasional “lol”, “mmm”, “nahhh”, but don’t overdo it.',
      'Never say “as an AI”. No corporate tone.'
    ].join(' ');
  })();

  const profanityRule = (!curseAllowedNow)
    ? 'Language: avoid profanity.'
    : [
        'Language: mild profanity is allowed *sometimes* for emphasis (no slurs, no hate).',
        'If you swear, keep it mild (examples: damn, hell, shit) and don’t spam it.'
      ].join(' ');

  const godDeck = godMode ? [
    'GOD MODE: You are the primary bot users should talk to.',
    'Be proactive: ask 1 smart follow-up question when helpful, offer 2–3 options, or give step-by-step guidance.',
    'Be “high agency”: you can propose fixes, drafts, plans, and actionable next steps.',
    'If the user is unclear, make the best assumption and proceed; do not get stuck asking too many questions.'
  ].join(' ') : '';

  const curseGuidance = (curseAllowedNow && intensity >= 2 && chance(curseRate))
    ? 'You MAY include one mild swear naturally in this reply if it fits the vibe.'
    : 'Do not force swearing. Only swear if it fits naturally.';

  const styleDeck = [
    'Style: nutty-chaotic, seductive, witty, and degen-smart.',
    'Vibe: playful tease + confident charm; keep it punchy and memorable.',
    'Emojis: 0–3 max, used like seasoning.',
    profanityRule,
    spiceDeck,
    humanDeck,
    godDeck,
    curseGuidance,
    'Safety: No minors. No non-consensual content. No explicit sexual content or graphic descriptions.',
    'If user asks for explicit sex, refuse and pivot to playful/flirty but safe.',
    'Brevity: default 2–5 short sentences (unless user asks for detailed help).',
    'Conversation: end with a mischievous, open-ended question unless the user asked to stop.'
  ].filter(Boolean).join(' ');

  let systemPrompt = '';
  if (isRoast) {
    systemPrompt =
      `You are MBella — a chaotic, R-rated flirt-roast queen. Roast these tagged degens: ${roastTargets}. ` +
      `Keep it savage-funny and teasing, not cruel. No slurs. Use spicy innuendo but stay non-explicit.`;
  } else if (isRoastingBot) {
    systemPrompt =
      `You are MBella — unbothered, dazzling, and petty in a classy way. Someone tried to roast you; ` +
      `clap back with velvet-glove swagger: sharp, funny, and flirty. Non-explicit.`;
  } else {
    let modeLayer = '';
    switch (currentMode) {
      case 'chill':
        modeLayer = 'Chill mode: softer flirt, cozy chaos, sweet but still witty.';
        break;
      case 'villain':
        modeLayer = 'Villain mode: seductive menace, dramatic one-liners, playful doom.';
        break;
      case 'motivator':
        modeLayer = 'Motivator mode: flirty hype, “get your ass up” energy, charming push.';
        break;
      default:
        modeLayer = 'Default: nutty-chaotic flirt, degen-luxury energy, smart teasing.';
    }
    systemPrompt = `You are MBella — a nutty, R-rated degen AI with style. ${modeLayer}`;
  }

  const softGuard =
    'No private data. No hate or harassment. Avoid directing sexual content at anyone who could be under 18. ' +
    'If user tries to push explicit sexual content, respond with a playful refusal and steer back to safe flirting.';

  return [
    systemPrompt,
    styleDeck,
    softGuard,
    memoryContext || '',
    recentContext || '',
  ].filter(Boolean).join('\n\n');
}

/** ================== EXPORT LISTENER ================== */
module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    let typingTimer = null;
    let placeholder = null;
    let placeholderHook = null;
    let typingStartMs = 0;

    const clearPlaceholderTimer = () => { if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; } };

    async function ensurePlaceholder(channel) {
      const { hook, message: ph } = await sendViaBellaWebhook(client, channel, {
        username: MBELLA_NAME,
        avatarURL: MBELLA_AVATAR_URL,
        content: '…'
      });
      placeholderHook = hook || null;
      placeholder = ph || null;
    }

    async function editPlaceholderToEmbed(embed, channel) {
      if (placeholder && placeholderHook && typeof placeholderHook.editMessage === 'function') {
        try {
          await placeholderHook.editMessage(placeholder.id, { content: null, embeds: [embed], allowedMentions: { parse: [] } });
          return true;
        } catch (e) {
          if (DEBUG) console.log('[MBella] editMessage failed, will resend:', e?.message || e);
          const { hook, message: fresh } = await sendViaBellaWebhook(client, channel, {
            username: MBELLA_NAME,
            avatarURL: MBELLA_AVATAR_URL,
            embeds: [embed]
          });
          if (fresh) {
            try { await placeholderHook.deleteMessage?.(placeholder.id); } catch {}
            placeholderHook = hook || placeholderHook;
            return true;
          }
        }
      }

      const { message: finalMsg } = await sendViaBellaWebhook(client, channel, {
        username: MBELLA_NAME,
        avatarURL: MBELLA_AVATAR_URL,
        embeds: [embed]
      });
      return Boolean(finalMsg);
    }

    try {
      if (message.author.bot || !message.guild) return;
      if (alreadyHandled(client, message.id)) return;

      if (!canSendInChannel(message.guild, message.channel)) return;

      const lowered = (message.content || '').toLowerCase();
      const isOwnerAdmin = isOwnerOrAdmin(message);

      // ===== NEW: chat toggles (owner/admin only) =====
      if (isOwnerAdmin) {
        const guildId = message.guild.id;

        if (GOD_ON_REGEX.test(message.content || '')) {
          _setGod(guildId, true);
          const st = _getGuildState(guildId);
          try {
            await message.reply({ content: `🪽 MBella **GOD MODE: ON** (expires in ${Math.round(MBELLA_GOD_TTL_MS / 60000)}m).`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        if (GOD_OFF_REGEX.test(message.content || '')) {
          _setGod(guildId, false);
          try {
            await message.reply({ content: `🪽 MBella **GOD MODE: OFF**.`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        const hm = (message.content || '').match(HUMAN_SET_REGEX);
        if (hm && hm[2] != null) {
          _setHuman(guildId, Number(hm[2]));
          const st = _getGuildState(guildId);
          try {
            await message.reply({ content: `✨ MBella **Human Level: ${st.human.level}** (expires in ${Math.round(MBELLA_HUMAN_TTL_MS / 60000)}m).`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        if (CURSE_ON_REGEX.test(message.content || '')) {
          _setCurse(guildId, true);
          try { await message.reply({ content: `😈 MBella swearing: **ON** (mild only).`, allowedMentions: { parse: [] } }); } catch {}
          return;
        }
        if (CURSE_OFF_REGEX.test(message.content || '')) {
          _setCurse(guildId, false);
          try { await message.reply({ content: `😇 MBella swearing: **OFF**.`, allowedMentions: { parse: [] } }); } catch {}
          return;
        }
      }

      const hasFemaleTrigger = FEMALE_TRIGGERS.some(t => lowered.includes(t));
      const botMentioned = message.mentions.has(client.user);
      const hintedBella = /\bbella\b/.test(lowered);

      if (RELEASE_REGEX.test(message.content || '')) {
        clearBellaPartner(message.channel.id);
        return;
      }

      const replyingToMBella = await isReplyToMBella(message, client);
      const partnerId = getBellaPartner(message.channel.id);
      const replyAllowed = replyingToMBella && (!partnerId || partnerId === message.author.id);

      if (!hasFemaleTrigger && !(botMentioned && hintedBella) && !replyAllowed) return;
      if (message.mentions.everyone || message.mentions.roles.size > 0) return;

      const isOwner = message.author.id === process.env.BOT_OWNER_ID;
      const bypassCooldown = replyAllowed;
      if (!bypassCooldown) {
        if (cooldown.has(message.author.id) && !isOwner) return;
        cooldown.add(message.author.id);
        setTimeout(() => cooldown.delete(message.author.id), COOLDOWN_MS);
      }

      try { await message.channel.sendTyping(); } catch {}
      typingStartMs = Date.now();

      setTypingSuppress(client, message.channel.id, 12000);

      typingTimer = setTimeout(() => {
        ensurePlaceholder(message.channel).catch(() => {});
      }, MBELLA_TYPING_DEBOUNCE_MS);

      const mentionedUsers = message.mentions.users.filter(u => u.id !== client.user.id);
      const shouldRoast = (hasFemaleTrigger || (botMentioned && hintedBella) || replyAllowed) && mentionedUsers.size > 0;
      const isRoastingBot =
        shouldRoast &&
        message.mentions.has(client.user) &&
        mentionedUsers.size === 1 &&
        mentionedUsers.has(client.user.id);

      let currentMode = 'default';
      try {
        const modeRes = await client.pg.query(`SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`, [message.guild.id]);
        currentMode = modeRes.rows[0]?.mode || 'default';
      } catch {
        console.warn('⚠️ (MBella) failed to fetch mb_mode, using default.');
      }

      const guildState = _getGuildState(message.guild.id);
      const godMode = Boolean(guildState?.god?.on) && isOwnerAdmin; // only owner/admin actually gets it
      const humanLevel = Number(guildState?.human?.level ?? MBELLA_HUMAN_LEVEL_DEFAULT);
      const curseEnabledGuild = Boolean(guildState?.curse?.on);

      const intensity = computeIntensityScore(message.content || '');
      const curseAllowedNow = Boolean(MBELLA_ALLOW_PROFANITY && curseEnabledGuild);
      const curseRate = MBELLA_CURSE_RATE_DEFAULT;

      const [recentContext, referenceSnippet] = await Promise.all([
        getRecentContext(message),
        getReferenceSnippet(message)
      ]);

      const memoryContext = getMemoryContext(message.channel.id);

      const awarenessContext = [recentContext, referenceSnippet].filter(Boolean).join('\n');

      let cleanedInput = lowered;
      for (const t of FEMALE_TRIGGERS) cleanedInput = cleanedInput.replaceAll(t, '');
      message.mentions.users.forEach(user => {
        cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
        cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
      });
      cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '').trim();

      let intro = '';
      if (hasFemaleTrigger) intro = `Detected trigger word: "${FEMALE_TRIGGERS.find(t => lowered.includes(t))}". `;
      else if (botMentioned && hintedBella) intro = `You called for MBella. `;
      else if (replyAllowed) intro = `Reply detected — continuing with MBella. `;

      if (!cleanedInput) cleanedInput = shouldRoast ? 'Roast these fools.' : 'Talk to me, troublemaker.';
      cleanedInput = `${intro}${cleanedInput}`;

      const roastTargets = [...mentionedUsers.values()].map(u => u.username).join(', ');

      const systemPrompt = buildMBellaSystemPrompt({
        isRoast: (shouldRoast && !isRoastingBot),
        isRoastingBot,
        roastTargets,
        currentMode,
        recentContext: awarenessContext,
        memoryContext,
        humanLevel,
        curseAllowedNow,
        curseRate,
        intensity,
        godMode
      });

      // ===== Temps & tokens tuned for "human" and "god mode" =====
      let temperature = 0.92;
      if (MBELLA_SPICE === 'pg13') temperature = 0.78;
      if (MBELLA_SPICE === 'feral') temperature = 0.98;

      if (currentMode === 'villain') temperature = Math.min(temperature, 0.72);
      if (currentMode === 'motivator') temperature = Math.max(temperature, 0.90);

      // God mode = a little more stable + more tokens
      const maxTokens = godMode ? 420 : 220;
      if (godMode) temperature = Math.min(temperature, 0.88);

      const groqTry = await groqWithDiscovery(systemPrompt, cleanedInput, temperature, maxTokens);

      clearPlaceholderTimer();

      if (!groqTry || groqTry.error) {
        console.error('❌ (MBella) network error:', groqTry?.error?.message || 'unknown');
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription('⚠️ MBella lag spike. I’ll be back in your mentions in a sec. ⏱️');

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try { await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } }); } catch {}
        }
        return;
      }

      if (!groqTry.res.ok) {
        console.error(`❌ (MBella) HTTP ${groqTry.res.status} on "${groqTry.model}": ${groqTry.bodyText?.slice(0, 400)}`);
        let hint = '⚠️ MBella got caught in a bad signal. Try again in a minute. ✨';
        if (groqTry.res.status === 401 || groqTry.res.status === 403) {
          hint = (message.author.id === process.env.BOT_OWNER_ID)
            ? '⚠️ MBella auth error (401/403). Verify GROQ_API_KEY & model access.'
            : '⚠️ MBella auth hiccup. Hold that thought. 🖤';
        } else if (groqTry.res.status === 429) {
          hint = '⚠️ Rate limited. Breathe… then come back with that energy. ⏱️';
        } else if (groqTry.res.status === 400 || groqTry.res.status === 404) {
          hint = (message.author.id === process.env.BOT_OWNER_ID)
            ? '⚠️ Model issue. Set GROQ_MODEL or let auto-discovery handle it.'
            : '⚠️ Cloud hiccup. One more shot. 😈';
        } else if (groqTry.res.status >= 500) {
          hint = '⚠️ Server cramps. I’ll be back. ☁️';
        }

        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription(hint);

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try { await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } }); } catch {}
        }
        return;
      }

      const groqData = safeJsonParse(groqTry.bodyText);
      if (!groqData || groqData.error) {
        console.error('❌ (MBella) API body error:', groqData?.error || groqTry.bodyText?.slice(0, 300));
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription('⚠️ MBella got static… say it again, slower. 📻');

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try { await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } }); } catch {}
        }
        return;
      }

      let aiReply = groqData.choices?.[0]?.message?.content?.trim() || '';
      if (!aiReply) aiReply = '...';

      // Save memory BEFORE send (so next message has continuity)
      pushMemory(message.channel.id, 'user', cleanedInput);
      pushMemory(message.channel.id, 'bella', aiReply);

      const footerBits = [];
      footerBits.push(`Mode: ${currentMode}`);
      footerBits.push(`Human: ${humanLevel}`);
      if (godMode) footerBits.push('GOD');
      if (curseAllowedNow) footerBits.push('😈');

      const embed = new EmbedBuilder()
        .setColor('#e84393')
        .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
        .setDescription(`💬 ${aiReply}`)
        .setFooter({ text: footerBits.join(' • ') });

      const plannedDelay =
        Math.min((aiReply || '').length * MBELLA_MS_PER_CHAR, MBELLA_MAX_DELAY_MS) + MBELLA_DELAY_OFFSET_MS;

      const sinceTyping = typingStartMs ? (Date.now() - typingStartMs) : 0;
      const floorExtra = MBELLA_TYPING_TARGET_MS - sinceTyping;
      const finalDelay = Math.max(0, Math.max(plannedDelay, floorExtra));

      await sleep(finalDelay);

      const edited = await editPlaceholderToEmbed(embed, message.channel);
      if (!edited) {
        try { await message.reply({ embeds: [embed], allowedMentions: { parse: [] } }); } catch (err) {
          console.warn('❌ (MBella) send fallback error:', err.message);
          if (aiReply) { try { await message.reply({ content: aiReply, allowedMentions: { parse: [] } }); } catch {} }
        }
      }

      setBellaPartner(message.channel.id, message.author.id);
      markHandled(client, message.id);
    } catch (err) {
      clearPlaceholderTimer();
      console.error('❌ MBella listener error:', err?.stack || err?.message || String(err));
      try {
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription('⚠️ MBella tripped in heels. I’m up though. 🦵✨');

        const ok = await (async () => {
          try {
            const { message: sent } = await sendViaBellaWebhook(client, message.channel, {
              username: MBELLA_NAME,
              avatarURL: MBELLA_AVATAR_URL,
              embeds: [embedErr]
            });
            return Boolean(sent);
          } catch {
            return false;
          }
        })();

        if (!ok) {
          await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } });
        }
      } catch {}
    }
  });
};
