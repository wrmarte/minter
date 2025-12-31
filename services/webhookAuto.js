// services/webhookAuto.js
const { PermissionsBitField } = require('discord.js');

// Per-channel cache (channelId -> Webhook)
const channelWebhookCache = new Map();

// Prevent race conditions (channelId -> Promise<Webhook|null>)
const inflight = new Map();

const DEBUG = String(process.env.WEBHOOKAUTO_DEBUG || '').trim() === '1';

/**
 * Best-effort: can we manage webhooks in this channel?
 * (Needed to fetch/create/refresh tokens reliably.)
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
 * Pick the best webhook from a collection:
 * 1) Bot-owned webhook (preferred)
 * 2) Any webhook matching the desired name (case-insensitive)  <-- allows “manual webhook” to work
 * 3) Any webhook that has a token (fallback)
 */
function pickBestWebhook(hooks, clientUserId, desiredName) {
  try {
    if (!hooks) return null;
    const arr = Array.isArray(hooks) ? hooks : [...hooks.values()];

    // 1) bot-owned
    const owned = arr.find(h => h?.owner?.id === clientUserId);
    if (owned) return owned;

    // 2) name match (manual)
    const dn = String(desiredName || '').trim().toLowerCase();
    if (dn) {
      const named = arr.find(h => String(h?.name || '').trim().toLowerCase() === dn);
      if (named) return named;
    }

    // 3) any tokened webhook (sometimes bots can use these if token present)
    const tokened = arr.find(h => Boolean(h?.token));
    if (tokened) return tokened;

    return null;
  } catch {
    return null;
  }
}

/**
 * If cached webhook is stale (deleted/rotated), clear it.
 */
async function validateCachedWebhook(hook) {
  try {
    if (!hook) return null;
    // If it can fetch itself, it’s likely valid
    if (typeof hook.fetch === 'function') {
      const fresh = await hook.fetch().catch(() => null);
      return fresh || hook;
    }
    return hook;
  } catch {
    return null;
  }
}

/**
 * Get or create a webhook for a channel.
 * - Prefers bot-owned webhook
 * - Falls back to a manually-created webhook named like opts.name
 * - Creates a webhook if none exist
 * - Caches results per channel
 */
async function getOrCreateWebhook(channel, {
  name = 'MB Relay',
  avatarURL = null
} = {}) {
  try {
    if (!channel || !channel.guild) return null;

    // If we already have an in-flight resolver for this channel, await it
    if (inflight.has(channel.id)) {
      try { return await inflight.get(channel.id); } catch { return null; }
    }

    const p = (async () => {
      // 1) Try cached first
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

      // If we can’t manage webhooks, we can’t fetch/create a token reliably.
      // Return null so caller can fall back to normal send.
      if (!hasPerms) {
        if (DEBUG) console.log(`[webhookAuto] No ManageWebhooks in #${channel.id} (${channel.guild.id})`);
        return null;
      }

      // 2) Fetch existing webhooks in channel
      const hooks = await channel.fetchWebhooks().catch(() => null);

      let hook = pickBestWebhook(hooks, clientUserId, name);

      // If we found a bot-owned webhook, we can safely edit it to standardize
      if (hook && hook.owner?.id === clientUserId) {
        try {
          await hook.edit({
            name,
            avatar: avatarURL || undefined
          });
        } catch (e) {
          // Not fatal
          if (DEBUG) console.log(`[webhookAuto] hook.edit failed: ${e?.message || e}`);
        }
      }

      // If we found a manually-created webhook (name match), do NOT edit it (not ours).
      // Just use it as-is IF it has a token (Discord usually returns token on fetchWebhooks with ManageWebhooks).
      if (hook && hook.owner?.id !== clientUserId) {
        if (!hook.token) {
          if (DEBUG) console.log(`[webhookAuto] Found manual webhook "${hook.name}" but token missing; will create our own.`);
          hook = null;
        } else if (DEBUG) {
          console.log(`[webhookAuto] Using manual webhook "${hook.name}" in #${channel.id}`);
        }
      }

      // 3) Create if missing
      if (!hook) {
        hook = await channel.createWebhook({
          name,
          avatar: avatarURL || undefined
        }).catch((e) => {
          if (DEBUG) console.log(`[webhookAuto] createWebhook failed: ${e?.message || e}`);
          return null;
        });

        if (hook && DEBUG) {
          console.log(`[webhookAuto] Created webhook "${name}" in #${channel.id}`);
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
  try { channelWebhookCache.delete(String(channelId)); } catch {}
  try { inflight.delete(String(channelId)); } catch {}
}

/**
 * Clear all cached webhooks (force re-discovery)
 */
function clearAllCache() {
  try { channelWebhookCache.clear(); } catch {}
  try { inflight.clear(); } catch {}
}

/**
 * Send a message via auto webhook.
 * - Retries once if cached webhook is stale (deleted/rotated)
 */
async function sendViaWebhook(channel, payload, opts = {}) {
  const safePayload = {
    ...payload,
    // Never allow mass-mentions through webhook relay
    allowedMentions: payload?.allowedMentions || { parse: [] }
  };

  // 1) acquire hook
  let hook = await getOrCreateWebhook(channel, opts);
  if (!hook) return false;

  // 2) attempt send
  try {
    await hook.send(safePayload);
    return true;
  } catch (e1) {
    if (DEBUG) console.log(`[webhookAuto] hook.send failed (1st try): ${e1?.message || e1}`);

    // If webhook got deleted/rotated, clear cache and retry once
    try { clearChannelCache(channel.id); } catch {}

    hook = await getOrCreateWebhook(channel, opts);
    if (!hook) return false;

    try {
      await hook.send(safePayload);
      return true;
    } catch (e2) {
      if (DEBUG) console.log(`[webhookAuto] hook.send failed (2nd try): ${e2?.message || e2}`);
      return false;
    }
  }
}

module.exports = {
  getOrCreateWebhook,
  sendViaWebhook,
  clearChannelCache,
  clearAllCache
};

