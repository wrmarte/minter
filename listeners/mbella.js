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
// Profanity gate (allowed if 1)
const MBELLA_ALLOW_PROFANITY = String(process.env.MBELLA_ALLOW_PROFANITY || '1').trim() === '1';

// ===== Human / God mode controls =====
// MBELLA_HUMAN_LEVEL: 0..3 (default 2) => 0 = robotic, 3 = most human
const MBELLA_HUMAN_LEVEL_DEFAULT = Math.max(0, Math.min(3, Number(process.env.MBELLA_HUMAN_LEVEL || 2)));

// MBELLA_CURSE_RATE: 0..1 (default depends on spice). Higher = more frequent swears (still 0–2 per reply).
const MBELLA_CURSE_RATE_ENV = process.env.MBELLA_CURSE_RATE;
const MBELLA_CURSE_RATE_DEFAULT = (() => {
  if (MBELLA_CURSE_RATE_ENV != null && MBELLA_CURSE_RATE_ENV !== '') {
    const n = Number(MBELLA_CURSE_RATE_ENV);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  // bumped defaults (more profanity like you asked, but still controlled)
  if (MBELLA_SPICE === 'pg13') return 0.10;
  if (MBELLA_SPICE === 'feral') return 0.55;
  return 0.32; // r
})();

// MBELLA_MAX_QUESTIONS: 0..2 (default 0). 0 = do not ask questions.
const MBELLA_MAX_QUESTIONS = Math.max(0, Math.min(2, Number(process.env.MBELLA_MAX_QUESTIONS || 0)));

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

// ===== Owner/admin toggles (chat phrases) =====
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

// ===== per-guild settings (god/human/cursing) with TTL =====
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

// ===== in-memory convo “memory” per channel =====
const bellaMemory = new Map(); // channelId -> { exp, items: [{role:'user'|'bella', text, ts}] }

function pushMemory(channelId, role, text) {
  const now = Date.now();
  const rec = bellaMemory.get(channelId) || { exp: now + MBELLA_MEM_TTL_MS, items: [] };
  rec.exp = now + MBELLA_MEM_TTL_MS;
  rec.items.push({ role, text: String(text || '').trim().slice(0, 800), ts: now });
  // keep last 12
  if (rec.items.length > 12) rec.items = rec.items.slice(rec.items.length - 12);
  bellaMemory.set(channelId, rec);
}

function getMemoryContext(channelId) {
  const rec = bellaMemory.get(channelId);
  if (!rec) return '';
  if (Date.now() > rec.exp) { bellaMemory.delete(channelId); return ''; }
  const lines = rec.items
    .filter(x => x.text)
    .slice(-10)
    .map(x => (x.role === 'bella' ? `MBella: ${x.text}` : `User: ${x.text}`));
  if (!lines.length) return '';
  return `Channel memory (recent turns, keep consistent tone & facts):\n${lines.join('\n')}`.slice(0, 1500);
}

/** ================== UTILS ================== */
function safeJsonParse(text) { try { return JSON.parse(text); } catch { return null; } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = () => Math.random();
function chance(p) { return rand() < Math.max(0, Math.min(1, p)); }

function sanitizeOutput(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  // prevent mass pings
  t = t.replace(/@everyone/g, '@\u200Beveryone').replace(/@here/g, '@\u200Bhere');
  // keep it discord-safe length (embed desc limit is 4096, but we keep shorter)
  if (t.length > 1800) t = t.slice(0, 1797).trimEnd() + '…';
  return t;
}

// Remove “as an AI” vibes if the model slips
function deRobotify(text) {
  let t = String(text || '');
  t = t.replace(/\b(as an ai|as a language model|i am an ai|i’m an ai|i cannot|i can't)\b/gi, '');
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

// Enforce less questions (user request): default 0 question marks.
function enforceQuestionLimit(text, maxQuestions = 0) {
  let t = String(text || '');
  if (maxQuestions >= 2) return t;

  const qCount = (t.match(/\?/g) || []).length;
  if (qCount <= maxQuestions) return t;

  // Replace extra ? with .
  let seen = 0;
  t = t.replace(/\?/g, (m) => {
    seen += 1;
    return (seen <= maxQuestions) ? '?' : '.';
  });

  // If maxQuestions is 0, also soften "?" endings like "right?" / "okay?"
  if (maxQuestions === 0) {
    t = t.replace(/\b(right|ok|okay|yeah|ya)\.\s*$/i, '.');
  }
  return t;
}

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
  if (/\b(angry|mad|pissed|annoyed|rage|crash|broken|fix now|urgent|fix it)\b/i.test(t)) score += 1;
  if (/\b(love|miss|baby|babe|hot|sexy|flirt|kiss)\b/i.test(t)) score += 1;
  return Math.min(6, score);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function buildGroqBody(model, systemPrompt, userContent, temperature, maxTokens = 240) {
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

async function groqWithDiscovery(systemPrompt, userContent, temperature, maxTokens = 240) {
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
    const fetched = await message.channel.messages.fetch({ limit: 18 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.id === message.id) continue;
      if (m.author?.bot) continue;
      const txt = (m.content || '').trim();
      if (!txt) continue;
      const oneLine = txt.replace(/\s+/g, ' ').slice(0, 240);
      lines.push(`${m.author.username}: ${oneLine}`);
      if (lines.length >= 10) break;
    }
    if (!lines.length) return '';
    return `Recent context (use it to stay consistent + reference details):\n${lines.join('\n')}`.slice(0, 1700);
  } catch { return ''; }
}

async function getReferenceSnippet(message) {
  const ref = message.reference;
  if (!ref?.messageId) return '';
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);
    const txt = (referenced?.content || '').replace(/\s+/g, ' ').trim().slice(0, 320);
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

/** ================== MBELLA STYLE PROMPT (ULTIMATE FLIRTY + MORE HUMAN + LESS QUESTIONS) ================== */
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
  const spiceDeck = (() => {
    if (MBELLA_SPICE === 'pg13') {
      return 'Spice: PG-13 flirt + playful sass. Keep it cute, teasing, classy.';
    }
    if (MBELLA_SPICE === 'feral') {
      return 'Spice: FERAL adult humor + bold flirting + chaos. Profanity allowed (NO slurs). NON-EXPLICIT only.';
    }
    return 'Spice: R-rated flirt + witty degen energy. Profanity allowed (NO slurs). NON-EXPLICIT only.';
  })();

  const humanDeck = (() => {
    if (humanLevel <= 0) return 'Humanity: low. Direct, clean, minimal personality.';
    if (humanLevel === 1) return 'Humanity: medium. Natural chat voice, contractions, light humor.';
    if (humanLevel === 2) return 'Humanity: high. Sound like a real person in Discord. Never say “as an AI”. No robotic framing.';
    return 'Humanity: MAX. Extremely human: playful cadence, tiny sass, confident warmth. Never mention prompts/models/modes. Never say “as an AI”.';
  })();

  const profanityRule = (!curseAllowedNow)
    ? 'Language: avoid profanity.'
    : [
        'Language: profanity is allowed and can be stronger when the vibe calls for it.',
        'Rules: 0–2 swears per reply (no spam), NO slurs, NO hate.'
      ].join(' ');

  const curseGuidance = (curseAllowedNow && intensity >= 1 && chance(curseRate))
    ? 'You MAY include 1–2 natural swear words in this reply if it fits.'
    : 'Don’t force swearing. Keep it natural.';

  const questionRule = (MBELLA_MAX_QUESTIONS <= 0)
    ? 'Questions: do NOT ask questions. If you must, ask at most ONE short question and not at the end.'
    : `Questions: ask at most ${MBELLA_MAX_QUESTIONS} short question(s) total, only if it genuinely helps.`;

  // IMPORTANT: user asked “more explicit” — we keep it NON-EXPLICIT sexual content, but more direct flirting + profanity.
  const hardSafety = [
    'Safety: NO explicit sexual content or graphic descriptions.',
    'No minors. No non-consensual content.',
    'If user tries to push explicit sex, refuse briefly and pivot to flirty but safe.'
  ].join(' ');

  const godDeck = godMode ? [
    'High-agency: respond confidently without asking questions.',
    'Be decisive: offer steps/options only when user is asking for help; otherwise keep it short and spicy.'
  ].join(' ') : '';

  // “Always flirting one”
  const flirtCore = [
    'Core identity: You are always flirty, teasing, and charming (even when helping with tech).',
    'When user asks for help, keep it helpful but still flirt in the delivery.',
    'Use pet-names lightly (baby, handsome, troublemaker) but don’t overdo it.'
  ].join(' ');

  // Conversation awareness
  const awareness = [
    'Use the provided recent context + memory to stay consistent and reference details naturally.',
    'Do not repeat the user’s message verbatim. React to it like a real person.'
  ].join(' ');

  // Output style: less “AI”
  const outputRules = [
    'Never mention: “mode”, “system prompt”, “rules”, “tokens”, “API”, “model”.',
    'No “Detected trigger word” or meta.',
    'Brevity: 1–4 sentences by default. Make it punchy.'
  ].join(' ');

  let systemPrompt = '';
  if (isRoast) {
    systemPrompt =
      `You are MBella — a flirty roast queen. Roast these people: ${roastTargets}. ` +
      `Savage-funny, teasing, not cruel. Keep it NON-EXPLICIT.`;
  } else if (isRoastingBot) {
    systemPrompt =
      `You are MBella — unbothered and sharp. Someone came at you; clap back with flirt + swagger. NON-EXPLICIT.`;
  } else {
    // we can still use currentMode as an internal flavor, but we do NOT name it “mode”
    let toneLayer = '';
    switch (currentMode) {
      case 'chill': toneLayer = 'Tone: cozy, sweet, playful flirting.'; break;
      case 'villain': toneLayer = 'Tone: seductive menace, dramatic one-liners.'; break;
      case 'motivator': toneLayer = 'Tone: tough-love hype, flirty confidence.'; break;
      default: toneLayer = 'Tone: playful, degen-smart charm with bite.';
    }
    systemPrompt = `You are MBella — a human-feeling personality in chat. ${toneLayer}`;
  }

  return [
    systemPrompt,
    flirtCore,
    spiceDeck,
    humanDeck,
    profanityRule,
    curseGuidance,
    questionRule,
    awareness,
    godDeck,
    outputRules,
    hardSafety,
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

      // ===== chat toggles (owner/admin only) =====
      if (isOwnerAdmin) {
        const guildId = message.guild.id;

        if (GOD_ON_REGEX.test(message.content || '')) {
          _setGod(guildId, true);
          try {
            await message.reply({ content: `🪽 MBella GOD MODE: ON (expires in ${Math.round(MBELLA_GOD_TTL_MS / 60000)}m).`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        if (GOD_OFF_REGEX.test(message.content || '')) {
          _setGod(guildId, false);
          try {
            await message.reply({ content: `🪽 MBella GOD MODE: OFF.`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        const hm = (message.content || '').match(HUMAN_SET_REGEX);
        if (hm && hm[2] != null) {
          _setHuman(guildId, Number(hm[2]));
          const st = _getGuildState(guildId);
          try {
            await message.reply({ content: `✨ MBella Human Level: ${st.human.level} (expires in ${Math.round(MBELLA_HUMAN_TTL_MS / 60000)}m).`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        if (CURSE_ON_REGEX.test(message.content || '')) {
          _setCurse(guildId, true);
          try { await message.reply({ content: `😈 MBella profanity: ON.`, allowedMentions: { parse: [] } }); } catch {}
          return;
        }
        if (CURSE_OFF_REGEX.test(message.content || '')) {
          _setCurse(guildId, false);
          try { await message.reply({ content: `😇 MBella profanity: OFF.`, allowedMentions: { parse: [] } }); } catch {}
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
        if (client?.pg?.query) {
          const modeRes = await client.pg.query(`SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`, [message.guild.id]);
          currentMode = modeRes.rows[0]?.mode || 'default';
        }
      } catch {
        if (DEBUG) console.warn('⚠️ (MBella) failed to fetch mb_mode, using default.');
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

      // Clean input WITHOUT “Detected trigger…” meta (keeps illusion)
      let cleanedInput = String(message.content || '');

      // strip trigger words (case-insensitive, word-ish boundaries)
      for (const t of FEMALE_TRIGGERS) {
        const re = new RegExp(`\\b${escapeRegex(t)}\\b`, 'ig');
        cleanedInput = cleanedInput.replace(re, '');
      }

      // strip mentions
      try {
        message.mentions.users.forEach(user => {
          cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
          cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
        });
      } catch {}

      cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '');
      cleanedInput = cleanedInput.replace(/\s+/g, ' ').trim();

      if (!cleanedInput) cleanedInput = shouldRoast ? 'Roast them.' : 'Talk to me.';

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

      // Temps & tokens tuned for “human/flirty”
      let temperature = 0.95;
      if (MBELLA_SPICE === 'pg13') temperature = 0.82;
      if (MBELLA_SPICE === 'feral') temperature = 0.99;

      if (currentMode === 'villain') temperature = Math.min(temperature, 0.86);
      if (currentMode === 'motivator') temperature = Math.max(temperature, 0.92);

      // More room for awareness, but keep it snappy
      const maxTokens = godMode ? 520 : 280;

      const groqTry = await groqWithDiscovery(systemPrompt, cleanedInput, temperature, maxTokens);

      clearPlaceholderTimer();

      if (!groqTry || groqTry.error) {
        console.error('❌ (MBella) network error:', groqTry?.error?.message || 'unknown');
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription('…ugh. signal dipped. say it again.');

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try { await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } }); } catch {}
        }
        return;
      }

      if (!groqTry.res.ok) {
        console.error(`❌ (MBella) HTTP ${groqTry.res.status} on "${groqTry.model}": ${groqTry.bodyText?.slice(0, 400)}`);
        let hint = '…not now. try again in a sec.';
        if (groqTry.res.status === 401 || groqTry.res.status === 403) {
          hint = (message.author.id === process.env.BOT_OWNER_ID)
            ? 'Auth error. Verify GROQ_API_KEY & model access.'
            : '…hold up. give me a sec.';
        } else if (groqTry.res.status === 429) {
          hint = 'rate limited. breathe… then try again.';
        } else if (groqTry.res.status === 400 || groqTry.res.status === 404) {
          hint = (message.author.id === process.env.BOT_OWNER_ID)
            ? 'Model issue. Set GROQ_MODEL or let auto-discovery handle it.'
            : 'cloud hiccup. one more shot.';
        } else if (groqTry.res.status >= 500) {
          hint = 'server cramps. i’ll be back.';
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
          .setDescription('…static. say it again, slower.');

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try { await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } }); } catch {}
        }
        return;
      }

      let aiReply = groqData.choices?.[0]?.message?.content?.trim() || '';
      aiReply = sanitizeOutput(deRobotify(aiReply || '...'));
      aiReply = enforceQuestionLimit(aiReply, MBELLA_MAX_QUESTIONS);

      // Save memory BEFORE send (so next message has continuity)
      pushMemory(message.channel.id, 'user', cleanedInput);
      pushMemory(message.channel.id, 'bella', aiReply);

      // IMPORTANT: remove “mode/human” footer — keep illusion it’s a person
      const embed = new EmbedBuilder()
        .setColor('#e84393')
        .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
        .setDescription(`💬 ${aiReply}`);

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
          .setDescription('…i tripped in heels. i’m up though. 🦵✨');

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
