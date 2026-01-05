// services/webhookAuto.js
// ======================================================
// Webhook Auto Helper (discord.js v14)
// - Caches per-channel webhook
// - Prefers bot-owned webhook
// - Can use a manually-created webhook IF we can fetch token (ManageWebhooks)
// - ✅ NEW: DB/ENV fallback to send via WebhookClient even WITHOUT ManageWebhooks
// - ✅ NEW: Supports "reply-like" behavior via messageReference when provided
// - Retries once if webhook is stale/deleted/rotated
// ======================================================

const { PermissionsBitField, WebhookClient } = require("discord.js");

// Per-channel cache (channelId -> Webhook|WebhookClient)
const channelWebhookCache = new Map();

// Prevent race conditions (channelId -> Promise<Webhook|WebhookClient|null>)
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

    // Prefer exact channel match; if not found, fall back to guild default row.
    const guildId = String(channel.guild.id);
    const channelId = String(channel.id);

    // 1) exact match
    const r1 = await pg.query(
      `SELECT webhook_url FROM guild_webhooks WHERE guild_id = $1 AND channel_id = $2 LIMIT 1`,
      [guildId, channelId]
    );
    const u1 = String(r1?.rows?.[0]?.webhook_url || "").trim();
    if (u1) return u1;

    // 2) guild default (any channel_id)
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

    // 1) bot-owned
    const owned = arr.find((h) => h?.owner?.id === clientUserId);
    if (owned) return owned;

    // 2) name match (manual)
    const dn = String(desiredName || "").trim().toLowerCase();
    if (dn) {
      const named = arr.find(
        (h) => String(h?.name || "").trim().toLowerCase() === dn
      );
      if (named) return named;
    }

    // 3) any tokened webhook
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

    // WebhookClient: no fetch(); if it exists, assume valid
    if (hookOrClient instanceof WebhookClient) return hookOrClient;

    // Webhook (from fetchWebhooks/createWebhook): can fetch itself
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
 * Get or create a webhook sender for a channel.
 * Returns either:
 * - discord.js Webhook (preferred when ManageWebhooks)
 * - discord.js WebhookClient (DB/ENV fallback)
 */
async function getOrCreateWebhook(
  channel,
  { name = "MB Relay", avatarURL = null } = {}
) {
  try {
    if (!channel || !channel.guild) return null;

    // If we already have an in-flight resolver for this channel, await it
    if (inflight.has(channel.id)) {
      try {
        return await inflight.get(channel.id);
      } catch {
        return null;
      }
    }

    const p = (async () => {
      // 1) Cached first
      const cached = channelWebhookCache.get(channel.id);
      if (cached) {
        const validated = await validateCachedWebhook(cached);
        if (validated) {
          channelWebhookCache.set(channel.id, validated);
          return validated;
        }
        channelWebhookCache.delete(channel.id);
      }

      const clientUserId = channel?.client?.user?.id;
      if (!clientUserId) return null;

      const hasPerms = canManageWebhooks(channel);

      // ✅ If we can't manage webhooks, try DB/ENV fallback (WebhookClient)
      if (!hasPerms) {
        if (DEBUG)
          dlog(
            `No ManageWebhooks in channel=${channel.id} guild=${channel.guild.id} -> trying DB/ENV webhook_url fallback`
          );

        // 1) DB (guild_webhooks table)
        const dbUrl = await fetchWebhookUrlFromDb(channel);
        const urlToUse = dbUrl || ENV_WEBHOOK_URL;

        if (urlToUse) {
          const wc = makeWebhookClient(urlToUse);
          if (wc) {
            channelWebhookCache.set(channel.id, wc);
            if (DEBUG) dlog(`Using WebhookClient fallback for channel=${channel.id} (url=${dbUrl ? "DB" : "ENV"})`);
            return wc;
          }
        }

        // No fallback available => caller should fall back to normal send
        return null;
      }

      // 2) Fetch existing webhooks in channel
      const hooks = await channel.fetchWebhooks().catch(() => null);
      let hook = pickBestWebhook(hooks, clientUserId, name);

      // If bot-owned, standardize name/avatar (safe)
      if (hook && hook.owner?.id === clientUserId) {
        try {
          await hook.edit({
            name,
            avatar: avatarURL || undefined,
          });
        } catch (e) {
          if (DEBUG) dlog(`hook.edit failed: ${e?.message || e}`);
        }
      }

      // If manual webhook, only use if token present
      if (hook && hook.owner?.id !== clientUserId) {
        if (!hook.token) {
          if (DEBUG)
            dlog(
              `Found manual webhook "${hook.name}" but token missing; will create our own.`
            );
          hook = null;
        } else if (DEBUG) {
          dlog(`Using manual webhook "${hook.name}" in channel=${channel.id}`);
        }
      }

      // 3) Create if missing
      if (!hook) {
        hook = await channel
          .createWebhook({
            name,
            avatar: avatarURL || undefined,
          })
          .catch((e) => {
            if (DEBUG) dlog(`createWebhook failed: ${e?.message || e}`);
            return null;
          });

        if (hook && DEBUG) {
          dlog(`Created webhook "${name}" in channel=${channel.id}`);
        }
      }

      if (hook) channelWebhookCache.set(channel.id, hook);
      return hook || null;
    })();

    inflight.set(channel.id, p);

    const out = await p.catch(() => null);
    return out;
  } catch {
    return null;
  } finally {
    try {
      if (channel?.id) inflight.delete(channel.id);
    } catch {}
  }
}

/**
 * Clear cached webhook for a channel (force re-fetch / re-create next send)
 */
function clearChannelCache(channelId) {
  try {
    channelWebhookCache.delete(String(channelId));
  } catch {}
  try {
    inflight.delete(String(channelId));
  } catch {}
}

/**
 * Clear all cached webhooks (force re-discovery)
 */
function clearAllCache() {
  try {
    channelWebhookCache.clear();
  } catch {}
  try {
    inflight.clear();
  } catch {}
}

/**
 * Normalize payload for webhook send.
 * ✅ Adds "reply-like" support if payload.messageReference is provided.
 *
 * Usage from caller:
 *  payload.messageReference = { messageId: "<id>" }
 *  OR payload.messageReference = "<id>"
 */
function normalizeSendPayload(payload = {}) {
  const safePayload = {
    ...payload,
    allowedMentions: payload?.allowedMentions || { parse: [] },
  };

  // allow shorthand: messageReference: "123"
  if (typeof safePayload.messageReference === "string") {
    safePayload.messageReference = { messageId: safePayload.messageReference };
  }

  // Some discord.js versions only accept `messageReference` inside MessagePayload,
  // but Webhook#send passes it through. If Discord ignores it, it will just send normally.
  return safePayload;
}

/**
 * Send a message via auto webhook.
 * - Returns true/false (keeps your existing callers)
 * - Retries once if cached webhook is stale (deleted/rotated)
 */
async function sendViaWebhook(channel, payload, opts = {}) {
  const safePayload = normalizeSendPayload(payload);

  // 1) acquire hook/client
  let hook = await getOrCreateWebhook(channel, opts);
  if (!hook) return false;

  // 2) attempt send
  try {
    await hook.send(safePayload);
    return true;
  } catch (e1) {
    if (DEBUG) dlog(`hook.send failed (1st try): ${e1?.message || e1}`);

    // If webhook got deleted/rotated, clear cache and retry once
    try {
      clearChannelCache(channel.id);
    } catch {}

    hook = await getOrCreateWebhook(channel, opts);
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

