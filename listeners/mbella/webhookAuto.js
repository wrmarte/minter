// services/webhookAuto.js
// ======================================================
// Webhook Auto Helper (discord.js v14)
// - Caches per-channel webhook
// - Uses existing webhook by name if found
// - Creates bot-owned webhook if missing (requires Manage Webhooks)
// - Self-heals if webhook is deleted (retry once)
// ======================================================

const { PermissionsBitField } = require("discord.js");

const DEBUG = String(process.env.WEBHOOKAUTO_DEBUG || "").trim() === "1";

// channelId -> { webhookId, name, ts }
const channelCache = new Map();

function log(...args) {
  if (DEBUG) console.log("[webhookAuto]", ...args);
}

function warn(...args) {
  console.warn("[webhookAuto]", ...args);
}

function canManageWebhooks(channel) {
  try {
    const guild = channel?.guild;
    const me = guild?.members?.me;
    if (!guild || !me || !channel?.permissionsFor) return false;
    const perms = channel.permissionsFor(me);
    return Boolean(perms?.has(PermissionsBitField.Flags.ManageWebhooks));
  } catch {
    return false;
  }
}

async function fetchWebhookById(channel, webhookId) {
  try {
    const hooks = await channel.fetchWebhooks();
    return hooks.get(String(webhookId)) || null;
  } catch (e) {
    log("fetchWebhookById failed:", e?.message || e);
    return null;
  }
}

async function findWebhookByName(channel, name) {
  try {
    const hooks = await channel.fetchWebhooks();
    const target = String(name || "").trim().toLowerCase();
    if (!target) return null;

    // Exact name match first
    let found = hooks.find((h) => String(h?.name || "").trim().toLowerCase() === target) || null;
    if (found) return found;

    // If no exact match, try "contains" (helps if Discord trims/renames slightly)
    found = hooks.find((h) => String(h?.name || "").trim().toLowerCase().includes(target)) || null;
    return found;
  } catch (e) {
    log("findWebhookByName failed:", e?.message || e);
    return null;
  }
}

async function createWebhook(channel, name, avatarURL) {
  try {
    if (!canManageWebhooks(channel)) {
      log(
        `Missing ManageWebhooks in channel=${channel?.id} guild=${channel?.guild?.id} -> cannot create`
      );
      return null;
    }

    const hook = await channel.createWebhook({
      name: String(name || "MB Relay").slice(0, 80),
      // discord.js uses `avatar` here (can be URL string)
      avatar: avatarURL || undefined,
      reason: "Auto webhook for MB relay identity",
    });

    log(`Created webhook id=${hook?.id} name="${hook?.name}" channel=${channel?.id}`);
    return hook || null;
  } catch (e) {
    warn("createWebhook failed:", e?.message || e);
    return null;
  }
}

function clearChannelCache(channelId) {
  try {
    channelCache.delete(String(channelId));
  } catch {}
}

async function getOrCreateWebhook(channel, opts = {}) {
  try {
    if (!channel?.id || !channel?.isTextBased?.()) return null;

    const name = String(opts.name || "MB Relay").trim();
    const avatarURL = (opts.avatarURL || "").trim() || null;

    const cached = channelCache.get(String(channel.id));
    if (cached?.webhookId) {
      const cachedHook = await fetchWebhookById(channel, cached.webhookId);
      if (cachedHook) {
        // Update avatar on bot-owned hooks if requested (safe)
        // NOTE: Editing requires Manage Webhooks. If missing, we still can send with overrides.
        if (avatarURL && canManageWebhooks(channel)) {
          try {
            // Only edit if bot owns it (avoid touching a manual webhook)
            const meId = channel.client?.user?.id;
            if (meId && cachedHook?.owner?.id === meId) {
              await cachedHook.edit({ avatar: avatarURL }).catch(() => {});
            }
          } catch {}
        }
        return cachedHook;
      } else {
        log(`Cached webhook missing/invalid -> clearing cache channel=${channel.id}`);
        clearChannelCache(channel.id);
      }
    }

    // Find existing by name
    const byName = await findWebhookByName(channel, name);
    if (byName) {
      channelCache.set(String(channel.id), { webhookId: byName.id, name: byName.name, ts: Date.now() });
      log(`Using existing webhook id=${byName.id} name="${byName.name}" channel=${channel.id}`);
      return byName;
    }

    // Create if missing
    const created = await createWebhook(channel, name, avatarURL);
    if (created) {
      channelCache.set(String(channel.id), { webhookId: created.id, name: created.name, ts: Date.now() });
      return created;
    }

    return null;
  } catch (e) {
    warn("getOrCreateWebhook failed:", e?.message || e);
    return null;
  }
}

async function sendViaWebhook(channel, payload = {}, opts = {}) {
  // Returns: { ok: boolean, hook: Webhook|null, message: Message|null }
  try {
    const hook = await getOrCreateWebhook(channel, opts);
    if (!hook) return { ok: false, hook: null, message: null };

    // Always block mass mentions through relay
    const allowedMentions = payload.allowedMentions || { parse: [] };

    // discord.js Webhook#send supports username/avatarURL overrides
    const sendPayload = {
      content: payload.content ?? null,
      embeds: payload.embeds || undefined,
      components: payload.components || undefined,
      files: payload.files || undefined,
      allowedMentions,

      // identity override
      username: payload.username || undefined,
      avatarURL: payload.avatarURL || undefined,

      // Optional (may be ignored by some clients; safe to pass)
      messageReference: payload.messageReference || undefined,
      threadId: payload.threadId || undefined,
    };

    const message = await hook.send(sendPayload);
    return { ok: true, hook, message };
  } catch (e) {
    const msg = String(e?.message || e);
    warn("sendViaWebhook failed:", msg);

    // Self-heal: webhook deleted/unknown -> clear cache + retry once
    if (/unknown webhook|404/i.test(msg)) {
      try {
        clearChannelCache(channel.id);
      } catch {}
      try {
        const hook2 = await getOrCreateWebhook(channel, opts);
        if (!hook2) return { ok: false, hook: null, message: null };
        const message2 = await hook2.send({
          content: payload.content ?? null,
          embeds: payload.embeds || undefined,
          components: payload.components || undefined,
          files: payload.files || undefined,
          allowedMentions: payload.allowedMentions || { parse: [] },
          username: payload.username || undefined,
          avatarURL: payload.avatarURL || undefined,
          messageReference: payload.messageReference || undefined,
          threadId: payload.threadId || undefined,
        });
        return { ok: true, hook: hook2, message: message2 };
      } catch (e2) {
        warn("sendViaWebhook retry failed:", e2?.message || e2);
        return { ok: false, hook: null, message: null };
      }
    }

    return { ok: false, hook: null, message: null };
  }
}

module.exports = {
  getOrCreateWebhook,
  sendViaWebhook,
  clearChannelCache,
};
