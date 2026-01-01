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
// MBELLA_SPICE: pg13 | r | feral   (default: feral-ish)
const MBELLA_SPICE = String(process.env.MBELLA_SPICE || 'feral').trim().toLowerCase();

// Allow profanity at all (hard gate)
const MBELLA_ALLOW_PROFANITY = String(process.env.MBELLA_ALLOW_PROFANITY || '1').trim() === '1';

// ===== Human / God mode controls =====
// MBELLA_HUMAN_LEVEL: 0..3 (default 3) => 0 = robotic, 3 = most human
const MBELLA_HUMAN_LEVEL_DEFAULT = Math.max(0, Math.min(3, Number(process.env.MBELLA_HUMAN_LEVEL || 3)));

// Output style: embed | plain  (YOU asked to bring embed back)
const MBELLA_OUTPUT_STYLE = String(process.env.MBELLA_OUTPUT_STYLE || 'embed').trim().toLowerCase();

// Question control (default 0 = don’t ask questions unless unavoidable)
const MBELLA_MAX_QUESTIONS = Math.max(0, Math.min(2, Number(process.env.MBELLA_MAX_QUESTIONS || 0)));

// Profanity frequency (0..1). Higher = more likely to include swears (still safe rules)
const MBELLA_CURSE_RATE_ENV = process.env.MBELLA_CURSE_RATE;
const MBELLA_CURSE_RATE_DEFAULT = (() => {
  if (MBELLA_CURSE_RATE_ENV != null && MBELLA_CURSE_RATE_ENV !== '') {
    const n = Number(MBELLA_CURSE_RATE_ENV);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  if (MBELLA_SPICE === 'pg13') return 0.08;
  if (MBELLA_SPICE === 'feral') return 0.45;
  return 0.30; // r
})();

// Default god mode for owner/admin (still toggleable)
const MBELLA_GOD_DEFAULT = String(process.env.MBELLA_GOD_DEFAULT || '0').trim() === '1';
// How long a chat-toggle stays active per guild
const MBELLA_GOD_TTL_MS = Number(process.env.MBELLA_GOD_TTL_MS || (30 * 60 * 1000)); // 30 min
const MBELLA_HUMAN_TTL_MS = Number(process.env.MBELLA_HUMAN_TTL_MS || (60 * 60 * 1000)); // 60 min
const MBELLA_MEM_TTL_MS = Number(process.env.MBELLA_MEM_TTL_MS || (45 * 60 * 1000)); // 45 min

// Pace (match MuscleMB by default)
const MBELLA_MS_PER_CHAR = Number(process.env.MBELLA_MS_PER_CHAR || '40');      // 40ms/char
const MBELLA_MAX_DELAY_MS = Number(process.env.MBELLA_MAX_DELAY_MS || '5000');  // 5s cap
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

// Optional: per-guild style override TTL
const MBELLA_STYLE_TTL_MS = Number(process.env.MBELLA_STYLE_TTL_MS || (60 * 60 * 1000)); // 60 min

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

// ===== per-guild settings (god/human/cursing/style) with TTL =====
const bellaGuildState = new Map(); // guildId -> state object

function _getGuildState(guildId) {
  if (!bellaGuildState.has(guildId)) {
    bellaGuildState.set(guildId, {
      god: { on: MBELLA_GOD_DEFAULT, exp: 0 },
      human: { level: MBELLA_HUMAN_LEVEL_DEFAULT, exp: 0 },
      curse: { on: MBELLA_ALLOW_PROFANITY, exp: 0 },
      style: { value: MBELLA_OUTPUT_STYLE, exp: 0 },
    });
  }
  const st = bellaGuildState.get(guildId);
  const now = Date.now();

  if (st.god.exp && now > st.god.exp) { st.god.on = MBELLA_GOD_DEFAULT; st.god.exp = 0; }
  if (st.human.exp && now > st.human.exp) { st.human.level = MBELLA_HUMAN_LEVEL_DEFAULT; st.human.exp = 0; }
  if (st.curse.exp && now > st.curse.exp) { st.curse.on = MBELLA_ALLOW_PROFANITY; st.curse.exp = 0; }
  if (st.style.exp && now > st.style.exp) { st.style.value = MBELLA_OUTPUT_STYLE; st.style.exp = 0; }

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
function _setStyle(guildId, value) {
  const st = _getGuildState(guildId);
  st.style.value = (value === 'embed') ? 'embed' : 'plain';
  st.style.exp = Date.now() + MBELLA_STYLE_TTL_MS;
}

// ===== in-memory convo “memory” per channel =====
const bellaMemory = new Map(); // channelId -> { exp, items: [{role:'user'|'bella', text, ts}] }

function pushMemory(channelId, role, text) {
  const now = Date.now();
  const rec = bellaMemory.get(channelId) || { exp: now + MBELLA_MEM_TTL_MS, items: [] };
  rec.exp = now + MBELLA_MEM_TTL_MS;
  rec.items.push({ role, text: String(text || '').trim().slice(0, 700), ts: now });
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
  return `Channel memory (keep consistent tone & facts):\n${lines.join('\n')}`.slice(0, 1400);
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

function computeIntensityScore(text) {
  const t = String(text || '');
  let score = 0;
  if (/[A-Z]{5,}/.test(t)) score += 1;
  if ((t.match(/!/g) || []).length >= 3) score += 1;
  if ((t.match(/\?/g) || []).length >= 3) score += 1;
  if (/\b(fuck|shit|damn|hell|wtf|lmao|lmfao)\b/i.test(t)) score += 1;
  if (/\b(angry|mad|pissed|annoyed|rage|crash|broken|fix now|urgent)\b/i.test(t)) score += 1;
  if (/\b(love|miss|baby|babe|hot|sexy|flirt)\b/i.test(t)) score += 1;
  return Math.min(6, score);
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

function buildGroqBody(model, systemPrompt, userContent, temperature, maxTokens = 260) {
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

async function groqWithDiscovery(systemPrompt, userContent, temperature, maxTokens = 260) {
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
    const fetched = await message.channel.messages.fetch({ limit: 14 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.id === message.id) continue;
      if (m.author?.bot) continue;
      const txt = (m.content || '').trim();
      if (!txt) continue;
      const oneLine = txt.replace(/\s+/g, ' ').slice(0, 240);
      lines.push(`${m.author.username}: ${oneLine}`);
      if (lines.length >= 9) break;
    }
    if (!lines.length) return '';
    return `Recent context:\n${lines.join('\n')}`.slice(0, 1600);
  } catch { return ''; }
}

async function getReferenceSnippet(message) {
  const ref = message.reference;
  if (!ref?.messageId) return '';
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);
    const txt = (referenced?.content || '').replace(/\s+/g, ' ').trim().slice(0, 300);
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

/**
 * Send via webhook, TRYING to reply to the trigger message.
 * We attempt multiple option shapes because webhook impls differ.
 */
async function sendViaBellaWebhookReply(client, channel, referenceMessage, { username, avatarURL, embeds, content }) {
  const hook = await getBellaWebhook(client, channel);
  if (!hook) return { hook: null, message: null };

  const basePayload = {
    username: username || MBELLA_NAME,
    avatarURL: (avatarURL || MBELLA_AVATAR_URL || undefined),
    embeds,
    content,
    allowedMentions: { parse: [] },
  };

  const refId = referenceMessage?.id;
  const chanId = channel?.id;
  const guildId = channel?.guild?.id;

  const attempts = [
    // Discord API-ish
    { ...basePayload, message_reference: refId ? { message_id: refId, channel_id: chanId, guild_id: guildId } : undefined },
    // Common camelCase variants
    { ...basePayload, messageReference: refId ? { messageId: refId, channelId: chanId, guildId } : undefined },
    // “reply” variants some libs accept
    { ...basePayload, reply: refId ? { messageReference: refId } : undefined },
    { ...basePayload, reply: refId ? { messageId: refId } : undefined },
    // Fallback no reply
    { ...basePayload }
  ].map(p => {
    // remove undefined keys shallowly
    const cleaned = {};
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      cleaned[k] = v;
    }
    return cleaned;
  });

  for (const payload of attempts) {
    try {
      const msg = await hook.send(payload);
      return { hook, message: msg || null };
    } catch (e) {
      if (DEBUG) console.log('[MBella] webhook send attempt failed:', e?.message || e);
      // try next
      continue;
    }
  }

  try { client.webhookAuto?.clearChannelCache?.(channel.id); } catch {}
  return { hook, message: null };
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

/** ================== OUTPUT HELPERS ================== */
function sanitizeOutput(text) {
  let t = String(text || '').trim();
  if (t.length > 1800) t = t.slice(0, 1797).trimEnd() + '…';
  t = t.replace(/@everyone/g, '@\u200Beveryone').replace(/@here/g, '@\u200Bhere');
  return t;
}

/** ================== MBELLA STYLE PROMPT (MORE HUMAN, MORE PROFANITY, LESS QUESTIONS) ================== */
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
  godMode,
  maxQuestions
}) {
  const spiceDeck = (() => {
    if (MBELLA_SPICE === 'pg13') {
      return 'Spice: PG-13 playful energy. No explicit sexual content.';
    }
    if (MBELLA_SPICE === 'feral') {
      return 'Spice: FERAL adult humor, chaotic charm, degen-smart. Profanity allowed (NO slurs). Still NO explicit sexual content.';
    }
    return 'Spice: R-rated humor, confident flirt, degen-smart. Profanity allowed (NO slurs). Still NO explicit sexual content.';
  })();

  const humanDeck = (() => {
    if (humanLevel <= 0) return 'Humanity: low. Keep responses direct and clean.';
    if (humanLevel === 1) return 'Humanity: medium. Natural speech + contractions, light humor.';
    if (humanLevel === 2) return 'Humanity: high. Sound like a real person in chat. No robotic framing. Never say “as an AI”.';
    return 'Humanity: MAX. Extremely human: casual cadence, tiny sass, confident warmth. Never say “as an AI”. Don’t narrate your process. Don’t mention prompts/models/modes.';
  })();

  const profanityRule = (!curseAllowedNow)
    ? 'Language: avoid profanity.'
    : 'Language: profanity is allowed and can be used naturally. No slurs, no hate. No explicit sexual content.';

  const questionRule = (maxQuestions <= 0)
    ? 'Questions: Do NOT ask questions. Only ask a question if absolutely necessary (rare).'
    : `Questions: Ask at most ${maxQuestions} short question(s) only if it genuinely helps. Otherwise continue confidently.`;

  const profanityNudge = (curseAllowedNow && intensity >= 1 && chance(curseRate))
    ? 'You MAY include 1–2 natural swear words in this reply (not spammy).'
    : 'Do not force swearing; keep it natural.';

  const godDeck = godMode
    ? 'GOD MODE: Be high-agency and useful. Give actionable steps/options without asking questions. If clarification is needed, assume the likely intent and proceed.'
    : '';

  const styleDeck = [
    'Style: chatty, witty, confident, and human.',
    'Tone: playful + slightly savage (when deserved).',
    'Length: 1–4 short sentences by default.',
    'IMPORTANT: Do NOT display or mention “mode”. No “Mode:” labels. No meta.',
    'Emojis: 0–2 max, optional.',
    profanityRule,
    spiceDeck,
    humanDeck,
    questionRule,
    godDeck,
    profanityNudge,
    'Safety: No minors. No non-consensual content. No explicit sexual content or graphic descriptions.',
    'If user pushes explicit sexual content, refuse briefly and pivot to safe teasing.'
  ].filter(Boolean).join(' ');

  let systemPrompt = '';
  if (isRoast) {
    systemPrompt =
      `You are MBella — a chaotic flirt-roast queen. Roast these tagged people: ${roastTargets}. ` +
      `Savage-funny, teasing, not cruel. No slurs. Keep it non-explicit.`;
  } else if (isRoastingBot) {
    systemPrompt =
      `You are MBella — unbothered and sharp. Someone tried you; clap back with confident swagger. ` +
      `Keep it funny, human, and non-explicit.`;
  } else {
    let modeLayer = '';
    switch (currentMode) {
      case 'chill': modeLayer = 'Chill: cozy, playful, a little sassy.'; break;
      case 'villain': modeLayer = 'Villain: seductive menace, sharp one-liners.'; break;
      case 'motivator': modeLayer = 'Motivator: tough-love hype, confident push.'; break;
      default: modeLayer = 'Default: degen-smart charm with bite.';
    }
    systemPrompt = `You are MBella — a human-feeling personality in chat. ${modeLayer}`;
  }

  const softGuard =
    'No private data. No hate or harassment. No slurs. Avoid targeting protected groups. Keep it safe and non-explicit.';

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

    async function ensurePlaceholder(channel, referenceMessage) {
      const { hook, message: ph } = await sendViaBellaWebhookReply(client, channel, referenceMessage, {
        username: MBELLA_NAME,
        avatarURL: MBELLA_AVATAR_URL,
        content: '…'
      });
      placeholderHook = hook || null;
      placeholder = ph || null;
    }

    async function editPlaceholderToEmbed(embed, channel, referenceMessage) {
      // Try edit placeholder (keeps reply-thread clean)
      if (placeholder && placeholderHook && typeof placeholderHook.editMessage === 'function') {
        try {
          await placeholderHook.editMessage(placeholder.id, { content: null, embeds: [embed], allowedMentions: { parse: [] } });
          return true;
        } catch (e) {
          if (DEBUG) console.log('[MBella] editMessage failed, will resend:', e?.message || e);
        }
      }

      // Resend as a reply via webhook (attempt message reference)
      const { message: sent } = await sendViaBellaWebhookReply(client, channel, referenceMessage, {
        username: MBELLA_NAME,
        avatarURL: MBELLA_AVATAR_URL,
        embeds: [embed]
      });
      return Boolean(sent);
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
          try { await message.reply({ content: `🪽 Bella’s **GOD MODE is ON**.`, allowedMentions: { parse: [] } }); } catch {}
          return;
        }
        if (GOD_OFF_REGEX.test(message.content || '')) {
          _setGod(guildId, false);
          try { await message.reply({ content: `🪽 Bella’s **GOD MODE is OFF**.`, allowedMentions: { parse: [] } }); } catch {}
          return;
        }
        const hm = (message.content || '').match(HUMAN_SET_REGEX);
        if (hm && hm[2] != null) {
          _setHuman(guildId, Number(hm[2]));
          try { await message.reply({ content: `✨ Bella is set to **Human ${Number(hm[2])}**.`, allowedMentions: { parse: [] } }); } catch {}
          return;
        }
        if (CURSE_ON_REGEX.test(message.content || '')) {
          _setCurse(guildId, true);
          try { await message.reply({ content: `😈 Bella profanity: **ON**.`, allowedMentions: { parse: [] } }); } catch {}
          return;
        }
        if (CURSE_OFF_REGEX.test(message.content || '')) {
          _setCurse(guildId, false);
          try { await message.reply({ content: `😇 Bella profanity: **OFF**.`, allowedMentions: { parse: [] } }); } catch {}
          return;
        }

        // Style override still supported, but you asked embed back — embed is default anyway.
        if (/\b(bella\s+style\s+embed)\b/i.test(message.content || '')) {
          _setStyle(guildId, 'embed');
          try { await message.reply({ content: `📦 Bella style: **embed**.`, allowedMentions: { parse: [] } }); } catch {}
          return;
        }
        if (/\b(bella\s+style\s+plain)\b/i.test(message.content || '')) {
          _setStyle(guildId, 'plain');
          try { await message.reply({ content: `🗣️ Bella style: **plain**.`, allowedMentions: { parse: [] } }); } catch {}
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
        ensurePlaceholder(message.channel, message).catch(() => {});
      }, MBELLA_TYPING_DEBOUNCE_MS);

      const mentionedUsers = message.mentions.users.filter(u => u.id !== client.user.id);
      const shouldRoast = (hasFemaleTrigger || (botMentioned && hintedBella) || replyAllowed) && mentionedUsers.size > 0;

      const roastKeywords = /\b(roast|trash|garbage|suck|weak|clown|noob|dumb|stupid|lame)\b|😂|🤣|💀/i;
      const isRoastingBot = botMentioned && mentionedUsers.size === 0 && roastKeywords.test(lowered);

      let currentMode = 'default';
      try {
        if (client?.pg?.query) {
          const modeRes = await client.pg.query(`SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`, [message.guild.id]);
          currentMode = modeRes.rows[0]?.mode || 'default';
        }
      } catch {
        console.warn('⚠️ (MBella) failed to fetch mb_mode, using default.');
      }

      const guildState = _getGuildState(message.guild.id);
      const godMode = Boolean(guildState?.god?.on) && isOwnerAdmin;
      const humanLevel = Number(guildState?.human?.level ?? MBELLA_HUMAN_LEVEL_DEFAULT);
      const curseEnabledGuild = Boolean(guildState?.curse?.on);

      // YOU asked: bring embed back (default embed), keep optional override for emergencies
      const style = (guildState?.style?.value === 'plain') ? 'plain' : 'embed';

      const intensity = computeIntensityScore(message.content || '');
      const curseAllowedNow = Boolean(MBELLA_ALLOW_PROFANITY && curseEnabledGuild);
      const curseRate = MBELLA_CURSE_RATE_DEFAULT;

      const [recentContext, referenceSnippet] = await Promise.all([
        getRecentContext(message),
        getReferenceSnippet(message)
      ]);

      const memoryContext = getMemoryContext(message.channel.id);
      const awarenessContext = [recentContext, referenceSnippet].filter(Boolean).join('\n');

      // Clean user input (remove triggers + mentions)
      let cleanedInput = (message.content || '').trim();

      for (const t of FEMALE_TRIGGERS) {
        try {
          const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          cleanedInput = cleanedInput.replaceAll(new RegExp(`\\b${esc}\\b`, 'ig'), '');
        } catch {}
      }

      try {
        message.mentions.users.forEach(user => {
          cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
          cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
        });
      } catch {}

      cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '').trim();
      if (!cleanedInput) cleanedInput = shouldRoast ? 'Roast these fools.' : 'Talk to me.';

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
        godMode,
        maxQuestions: MBELLA_MAX_QUESTIONS
      });

      // Temps & tokens
      let temperature = 0.98;
      if (MBELLA_SPICE === 'pg13') temperature = 0.82;
      if (currentMode === 'villain') temperature = Math.min(temperature, 0.80);
      if (currentMode === 'motivator') temperature = Math.max(temperature, 0.92);

      const maxTokens = godMode ? 520 : 280;
      if (godMode) temperature = Math.min(temperature, 0.92);

      const groqTry = await groqWithDiscovery(systemPrompt, cleanedInput, temperature, maxTokens);

      clearPlaceholderTimer();

      if (!groqTry || groqTry.error) {
        console.error('❌ (MBella) network error:', groqTry?.error?.message || 'unknown');
        const out = sanitizeOutput('…ugh. signal dipped. say it again.');
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription(out);

        if (style === 'embed') {
          const ok = await editPlaceholderToEmbed(embedErr, message.channel, message);
          if (!ok) { try { await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } }); } catch {} }
        } else {
          try { await message.reply({ content: out, allowedMentions: { parse: [] } }); } catch {}
        }
        return;
      }

      if (!groqTry.res.ok) {
        console.error(`❌ (MBella) HTTP ${groqTry.res.status} on "${groqTry.model}": ${groqTry.bodyText?.slice(0, 400)}`);
        let hint = '…not now. try again in a sec.';
        if (groqTry.res.status === 401 || groqTry.res.status === 403) hint = isOwner ? 'Auth issue. Check GROQ_API_KEY.' : '…hold up. give me a sec.';
        else if (groqTry.res.status === 429) hint = 'rate limit. breathe. try again.';
        else if (groqTry.res.status >= 500) hint = 'server cramps. i’ll be back.';

        const out = sanitizeOutput(hint);
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription(out);

        if (style === 'embed') {
          const ok = await editPlaceholderToEmbed(embedErr, message.channel, message);
          if (!ok) { try { await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } }); } catch {} }
        } else {
          try { await message.reply({ content: out, allowedMentions: { parse: [] } }); } catch {}
        }
        return;
      }

      const groqData = safeJsonParse(groqTry.bodyText);
      if (!groqData || groqData.error) {
        console.error('❌ (MBella) API body error:', groqData?.error || groqTry.bodyText?.slice(0, 300));
        const out = sanitizeOutput('…static. say it again, slower.');
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription(out);

        if (style === 'embed') {
          const ok = await editPlaceholderToEmbed(embedErr, message.channel, message);
          if (!ok) { try { await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } }); } catch {} }
        } else {
          try { await message.reply({ content: out, allowedMentions: { parse: [] } }); } catch {}
        }
        return;
      }

      let aiReply = groqData.choices?.[0]?.message?.content?.trim() || '';
      aiReply = sanitizeOutput(aiReply || '…');

      // Save memory
      pushMemory(message.channel.id, 'user', cleanedInput);
      pushMemory(message.channel.id, 'bella', aiReply);

      // EMBED back, NO mode display, and should reply to trigger message
      const embed = new EmbedBuilder()
        .setColor('#e84393')
        .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
        .setDescription(aiReply);

      const plannedDelay =
        Math.min((aiReply || '').length * MBELLA_MS_PER_CHAR, MBELLA_MAX_DELAY_MS) + MBELLA_DELAY_OFFSET_MS;

      const sinceTyping = typingStartMs ? (Date.now() - typingStartMs) : 0;
      const floorExtra = MBELLA_TYPING_TARGET_MS - sinceTyping;
      const finalDelay = Math.max(0, Math.max(plannedDelay, floorExtra));

      await sleep(finalDelay);

      if (style === 'embed') {
        const ok = await editPlaceholderToEmbed(embed, message.channel, message);
        if (!ok) {
          // If webhook reply couldn't happen, fall back to actual Discord reply (still replies to trigger message)
          try { await message.reply({ embeds: [embed], allowedMentions: { parse: [] } }); } catch {}
        }
      } else {
        try { await message.reply({ content: aiReply, allowedMentions: { parse: [] } }); } catch {}
      }

      setBellaPartner(message.channel.id, message.author.id);
      markHandled(client, message.id);

    } catch (err) {
      clearPlaceholderTimer();
      console.error('❌ MBella listener error:', err?.stack || err?.message || String(err));
      try {
        const out = sanitizeOutput('…i tripped. i’m up though.');
        const embedErr = new EmbedBuilder()
          .setColor('#e84393')
          .setAuthor({ name: MBELLA_NAME, iconURL: MBELLA_AVATAR_URL || undefined })
          .setDescription(out);

        // Try webhook reply first
        const { message: sent } = await sendViaBellaWebhookReply(client, message.channel, message, {
          username: MBELLA_NAME,
          avatarURL: MBELLA_AVATAR_URL,
          embeds: [embedErr]
        });

        if (!sent) {
          await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } });
        }
      } catch {}
    }
  });
};

