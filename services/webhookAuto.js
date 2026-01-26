// services/webhookAuto.js
// ======================================================
// Webhook Auto Helper (discord.js v14)
// - Caches per-channel webhook
// - Prefers bot-owned webhook
// - Can use a manually-created webhook IF we can fetch token (ManageWebhooks)
// - ✅ Supports DB/ENV fallback to send via WebhookClient even WITHOUT ManageWebhooks
// - ✅ Supports "reply-like" behavior via messageReference when provided
// - ✅ PATCH: NEVER edits webhook identity (name/avatar) — avoids persona cross-talk
// - ✅ PATCH: Injects username/avatarURL per-message payload (correct identity every send)
// - ✅ PATCH: Cache key includes persona name to avoid shared-state collisions
// - Retries once if webhook is stale/deleted/rotated
// ======================================================

const { PermissionsBitField, WebhookClient } = require("discord.js");

// Per-channel cache (cacheKey -> Webhook|WebhookClient)
const channelWebhookCache = new Map();

// Prevent race conditions (cacheKey -> Promise<Webhook|WebhookClient|null>)
const inflight = new Map();

const DEBUG = String(process.env.WEBHOOKAUTO_DEBUG || "").trim() === "1";

// Optional env fallback (incoming webhook URL)
const ENV_WEBHOOK_URL = String(process.env.MB_RELAY_WEBHOOK_URL || "").trim();

function dlog(...args) {
  if (DEBUG) console.log("[webhookAuto]", ...args);
}

/**
 * Best-effort: can we manage webhooks in this channel?
 */
function canManageWebhooks(channel) {
  try {
    if (!channel?.guild) return false;
    const me = channel.guild.members.me;
    if (!me) return false;
    const perms = channel.permissionsFor(me);
    return Boolean(perms?.has(PermissionsBitField.Flags.ManageWebhooks));
  } catch {
    return false;
  }
}

/**
 * Build a WebhookClient from URL (works without ManageWebhooks).
 */
function makeWebhookClient(url) {
  try {
    if (!url) return null;
    const wc = new WebhookClient({ url: String(url).trim() });
    return wc;
  } catch {
    return null;
  }
}

/**
 * DB fallback:
 * - Uses client.pg (if attached) and guild_webhooks table created in index.js
 * - Looks up webhook_url for this guild (optionally channel match)
 */
async function fetchWebhookUrlFromDb(channel) {
  try {
    const client = channel?.client;
    const pg = client?.pg;
    if (!pg?.query) return "";

    const guildId = String(channel.guild.id);
    const channelId = String(channel.id);

    const r1 = await pg.query(
      `SELECT webhook_url FROM guild_webhooks WHERE guild_id = $1 AND channel_id = $2 LIMIT 1`,
      [guildId, channelId]
    );
    const u1 = String(r1?.rows?.[0]?.webhook_url || "").trim();
    if (u1) return u1;

    const r2 = await pg.query(
      `SELECT webhook_url FROM guild_webhooks WHERE guild_id = $1 LIMIT 1`,
      [guildId]
    );
    const u2 = String(r2?.rows?.[0]?.webhook_url || "").trim();
    return u2 || "";
  } catch (e) {
    dlog("DB webhook_url lookup failed:", e?.message || e);
    return "";
  }
}

/**
 * Pick the best webhook from a collection:
 * 1) Bot-owned webhook (preferred)
 * 2) Any webhook matching desired name (case-insensitive) <-- manual webhook support
 * 3) Any webhook that has a token (fallback)
 */
function pickBestWebhook(hooks, clientUserId, desiredName) {
  try {
    if (!hooks) return null;
    const arr = Array.isArray(hooks) ? hooks : [...hooks.values()];

    const owned = arr.find((h) => h?.owner?.id === clientUserId);
    if (owned) return owned;

    const dn = String(desiredName || "").trim().toLowerCase();
    if (dn) {
      const named = arr.find(
        (h) => String(h?.name || "").trim().toLowerCase() === dn
      );
      if (named) return named;
    }

    const tokened = arr.find((h) => Boolean(h?.token));
    if (tokened) return tokened;

    return null;
  } catch {
    return null;
  }
}

/**
 * If cached webhook is stale (deleted/rotated), clear it.
 */
async function validateCachedWebhook(hookOrClient) {
  try {
    if (!hookOrClient) return null;

    // WebhookClient: no fetch(); assume valid
    if (hookOrClient instanceof WebhookClient) return hookOrClient;

    // Webhook: can fetch itself
    if (typeof hookOrClient.fetch === "function") {
      const fresh = await hookOrClient.fetch().catch(() => null);
      return fresh || hookOrClient;
    }

    return hookOrClient;
  } catch {
    return null;
  }
}

/**
 * Cache key includes persona name so inflight/cache don't collide across MB/Bella.
 * Note: We do NOT create separate webhooks per persona by default.
 * The key separation prevents race/collision in resolver state, and since we no longer
 * edit the webhook identity, using one bot-owned webhook is safe.
 */
function cacheKeyFor(channel, desiredName) {
  const cid = String(channel?.id || "");
  const name = String(desiredName || "").trim().toLowerCase() || "default";
  return `${cid}:${name}`;
}

/**
 * Get or create a webhook sender for a channel.
 * Returns either:
 * - discord.js Webhook (preferred when ManageWebhooks)
 * - discord.js WebhookClient (DB/ENV fallback)
 *
 * ✅ PATCH: never edits webhook name/avatar — identity is per-message payload now.
 */
async function getOrCreateWebhook(
  channel,
  { name = "MB Relay", avatarURL = null } = {}
) {
  try {
    if (!channel || !channel.guild) return null;

    const key = cacheKeyFor(channel, name);

    if (inflight.has(key)) {
      try {
        return await inflight.get(key);
      } catch {
        return null;
      }
    }

    const p = (async () => {
      // 1) Cache first (by persona key)
      const cached = channelWebhookCache.get(key);
      if (cached) {
        const validated = await validateCachedWebhook(cached);
        if (validated) {
          channelWebhookCache.set(key, validated);
          return validated;
        }
        channelWebhookCache.delete(key);
      }

      const clientUserId = channel?.client?.user?.id;
      if (!clientUserId) return null;

      const hasPerms = canManageWebhooks(channel);

      // If no ManageWebhooks: try DB/ENV fallback (WebhookClient)
      if (!hasPerms) {
        if (DEBUG) {
          dlog(
            `No ManageWebhooks in channel=${channel.id} guild=${channel.guild.id} -> trying DB/ENV webhook_url fallback`
          );
        }

        const dbUrl = await fetchWebhookUrlFromDb(channel);
        const urlToUse = dbUrl || ENV_WEBHOOK_URL;

        if (urlToUse) {
          const wc = makeWebhookClient(urlToUse);
          if (wc) {
            channelWebhookCache.set(key, wc);
            if (DEBUG) dlog(`Using WebhookClient fallback for channel=${channel.id} (url=${dbUrl ? "DB" : "ENV"})`);
            return wc;
          }
        }

        return null;
      }

      // 2) Fetch existing webhooks
      const hooks = await channel.fetchWebhooks().catch(() => null);
      let hook = pickBestWebhook(hooks, clientUserId, name);

      // If manual webhook and token missing, ignore
      if (hook && hook.owner?.id !== clientUserId) {
        if (!hook.token) {
          if (DEBUG) dlog(`Found manual webhook "${hook.name}" but token missing; will create our own.`);
          hook = null;
        } else if (DEBUG) {
          dlog(`Using manual webhook "${hook.name}" in channel=${channel.id}`);
        }
      }

      // 3) Create if missing
      if (!hook) {
        hook = await channel
          .createWebhook({
            name, // initial name only; we will not keep editing it
            avatar: avatarURL || undefined,
          })
          .catch((e) => {
            if (DEBUG) dlog(`createWebhook failed: ${e?.message || e}`);
            return null;
          });

        if (hook && DEBUG) dlog(`Created webhook "${name}" in channel=${channel.id}`);
      }

      if (hook) channelWebhookCache.set(key, hook);
      return hook || null;
    })();

    inflight.set(key, p);

    const out = await p.catch(() => null);
    return out;
  } catch {
    return null;
  } finally {
    try {
      const key = cacheKeyFor(channel, name);
      inflight.delete(key);
    } catch {}
  }
}

/**
 * Clear cached webhook for a channel (force re-fetch / re-create next send)
 * Supports either channelId only or channelId:persona keys.
 */
function clearChannelCache(channelIdOrKey) {
  const k = String(channelIdOrKey || "");
  try {
    // If they pass raw channelId, clear all persona keys for that channel
    if (/^\d+$/.test(k)) {
      for (const key of [...channelWebhookCache.keys()]) {
        if (String(key).startsWith(`${k}:`)) channelWebhookCache.delete(key);
      }
      for (const key of [...inflight.keys()]) {
        if (String(key).startsWith(`${k}:`)) inflight.delete(key);
      }
      return;
    }

    channelWebhookCache.delete(k);
    inflight.delete(k);
  } catch {}
}

/**
 * Clear all cached webhooks (force re-discovery)
 */
function clearAllCache() {
  try { channelWebhookCache.clear(); } catch {}
  try { inflight.clear(); } catch {}
}

/**
 * Normalize payload for webhook send.
 * ✅ Adds "reply-like" support if payload.messageReference is provided.
 */
function normalizeSendPayload(payload = {}) {
  const safePayload = {
    ...payload,
    allowedMentions: payload?.allowedMentions || { parse: [] },
  };

  if (typeof safePayload.messageReference === "string") {
    safePayload.messageReference = { messageId: safePayload.messageReference };
  }

  return safePayload;
}

/**
 * Ensure per-message identity is applied.
 * ✅ PATCH: THIS is the real persona fix — identity must be on payload each send.
 */
function applyIdentityToPayload(payload, opts = {}) {
  const out = { ...payload };

  // Respect payload identity first
  const username =
    (typeof out.username === "string" && out.username.trim())
      ? out.username.trim()
      : (typeof opts?.name === "string" && opts.name.trim())
        ? opts.name.trim()
        : undefined;

  const avatarURL =
    (typeof out.avatarURL === "string" && out.avatarURL.trim())
      ? out.avatarURL.trim()
      : (typeof opts?.avatarURL === "string" && opts.avatarURL.trim())
        ? opts.avatarURL.trim()
        : undefined;

  if (username) out.username = username;
  if (avatarURL) out.avatarURL = avatarURL;

  // Never allow mass pings
  out.allowedMentions = out.allowedMentions || { parse: [] };
  if (!out.allowedMentions.parse) out.allowedMentions.parse = [];

  return out;
}

/**
 * Send a message via auto webhook.
 * - Returns true/false
 * - Retries once if cached webhook is stale (deleted/rotated)
 */
async function sendViaWebhook(channel, payload, opts = {}) {
  const desiredName = String(opts?.name || payload?.username || "MB Relay");
  const desiredAvatar = String(opts?.avatarURL || payload?.avatarURL || "") || null;

  const safePayload0 = normalizeSendPayload(payload);
  const safePayload = applyIdentityToPayload(safePayload0, { name: desiredName, avatarURL: desiredAvatar });

  // 1) acquire hook/client
  let hook = await getOrCreateWebhook(channel, { name: desiredName, avatarURL: desiredAvatar });
  if (!hook) return false;

  // 2) attempt send
  try {
    await hook.send(safePayload);
    return true;
  } catch (e1) {
    if (DEBUG) dlog(`hook.send failed (1st try): ${e1?.message || e1}`);

    // Clear cache for this persona in this channel and retry once
    try {
      clearChannelCache(cacheKeyFor(channel, desiredName));
    } catch {}

    hook = await getOrCreateWebhook(channel, { name: desiredName, avatarURL: desiredAvatar });
    if (!hook) return false;

    try {
      await hook.send(safePayload);
      return true;
    } catch (e2) {
      if (DEBUG) dlog(`hook.send failed (2nd try): ${e2?.message || e2}`);
      return false;
    }
  }
}

module.exports = {
  getOrCreateWebhook,
  sendViaWebhook,
  clearChannelCache,
  clearAllCache,
};

