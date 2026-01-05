// listeners/mbella/state.js
// ======================================================
// Runtime state: handled ids, cooldown, partner lock, typing suppress, guild toggles
// ======================================================

const Config = require("./config");

// handled tracking
function alreadyHandled(client, messageId) {
  if (!client.__mbHandled) client.__mbHandled = new Set();
  return client.__mbHandled.has(messageId);
}
function markHandled(client, messageId) {
  if (!client.__mbHandled) client.__mbHandled = new Set();
  client.__mbHandled.add(messageId);
  setTimeout(() => client.__mbHandled.delete(messageId), 60_000);
}

// cooldown
const cooldown = new Set();
function cooldownHas(userId) {
  return cooldown.has(userId);
}
function cooldownAdd(userId) {
  cooldown.add(userId);
}
function cooldownDelete(userId) {
  cooldown.delete(userId);
}

// partner lock
const bellaPartners = new Map(); // channelId -> { userId, expiresAt }
function setBellaPartner(channelId, userId, ttlMs) {
  bellaPartners.set(channelId, {
    userId,
    expiresAt: Date.now() + Number(ttlMs || Config.BELLA_TTL_MS),
  });
}
function getBellaPartner(channelId) {
  const rec = bellaPartners.get(channelId);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    bellaPartners.delete(channelId);
    return null;
  }
  return rec.userId;
}
function clearBellaPartner(channelId) {
  bellaPartners.delete(channelId);
}

/**
 * ✅ Minimal fix:
 * Replies to MBella should ALWAYS be allowed (partner lock must not block them).
 * Non-reply triggers still respect the partner lock.
 */
function isPartnerAllowed(channelId, userId, replyingToMBella) {
  if (replyingToMBella) return true;

  const partnerId = getBellaPartner(channelId);
  if (!partnerId) return true;
  return String(partnerId) === String(userId);
}

// typing suppress (shared on client)
function setTypingSuppress(client, channelId, ms = 12000) {
  if (!client.__mbTypingSuppress) client.__mbTypingSuppress = new Map();
  const until = Date.now() + ms;
  client.__mbTypingSuppress.set(channelId, until);
  setTimeout(() => {
    const exp = client.__mbTypingSuppress.get(channelId);
    if (exp && exp <= Date.now()) client.__mbTypingSuppress.delete(channelId);
  }, ms + 500);
}

// per-guild settings with TTL
const bellaGuildState = new Map(); // guildId -> { god, human, curse }

function getGuildState(guildId) {
  if (!bellaGuildState.has(guildId)) {
    bellaGuildState.set(guildId, {
      god: { on: Config.MBELLA_GOD_DEFAULT, exp: 0 },
      human: { level: Config.MBELLA_HUMAN_LEVEL_DEFAULT, exp: 0 },
      curse: { on: Config.MBELLA_ALLOW_PROFANITY, exp: 0 },
    });
  }
  const st = bellaGuildState.get(guildId);

  const now = Date.now();
  if (st.god.exp && now > st.god.exp) {
    st.god.on = Config.MBELLA_GOD_DEFAULT;
    st.god.exp = 0;
  }
  if (st.human.exp && now > st.human.exp) {
    st.human.level = Config.MBELLA_HUMAN_LEVEL_DEFAULT;
    st.human.exp = 0;
  }
  if (st.curse.exp && now > st.curse.exp) {
    st.curse.on = Config.MBELLA_ALLOW_PROFANITY;
    st.curse.exp = 0;
  }

  return st;
}

function setGod(guildId, on) {
  const st = getGuildState(guildId);
  st.god.on = Boolean(on);
  st.god.exp = Date.now() + Config.MBELLA_GOD_TTL_MS;
}
function setHuman(guildId, level) {
  const st = getGuildState(guildId);
  st.human.level = Math.max(0, Math.min(3, Number(level)));
  st.human.exp = Date.now() + Config.MBELLA_HUMAN_TTL_MS;
}
function setCurse(guildId, on) {
  const st = getGuildState(guildId);
  st.curse.on = Boolean(on);
  st.curse.exp = Date.now() + Config.MBELLA_HUMAN_TTL_MS;
}

module.exports = {
  alreadyHandled,
  markHandled,

  cooldownHas,
  cooldownAdd,
  cooldownDelete,

  setBellaPartner,
  getBellaPartner,
  clearBellaPartner,

  // ✅ NEW (tiny)
  isPartnerAllowed,

  setTypingSuppress,

  getGuildState,
  setGod,
  setHuman,
  setCurse,
};
