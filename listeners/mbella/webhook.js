// listeners/mbella/webhook.js
// ======================================================
// Webhook sending helpers (uses client.webhookAuto)
//
// ✅ PATCH:
// - Webhook API does NOT support true Discord "reply arrow" (message_reference / reply)
// - If you include "reply" or "messageReference" in webhook.send payload,
//   Discord can reject with 400 Invalid Form Body -> causing fallback to bot sender.
//
// So we ACCEPT reply/messageReference args but DO NOT send them.
// Use your embed "reply header" + jump link instead.
// ======================================================

const { PermissionsBitField } = require("discord.js");
const Config = require("./config");

async function getBellaWebhook(client, channel) {
  try {
    const wa = client?.webhookAuto;
    if (!wa || typeof wa.getOrCreateWebhook !== "function") {
      if (Config.DEBUG) console.log("[MBella] client.webhookAuto missing. (Did you patch index.js?)");
      return null;
    }

    const hook = await wa.getOrCreateWebhook(channel, {
      name: Config.MB_RELAY_WEBHOOK_NAME,
      avatarURL: Config.MBELLA_AVATAR_URL || null,
    });

    if (!hook && Config.DEBUG) {
      const me = channel?.guild?.members?.me;
      const perms = me && channel?.permissionsFor?.(me) ? channel.permissionsFor(me) : null;
      const hasMW = perms?.has(PermissionsBitField.Flags.ManageWebhooks);
      console.log(
        `[MBella] No webhook returned. ManageWebhooks=${hasMW ? "YES" : "NO"} channel=${channel?.id} guild=${channel?.guild?.id}`
      );
    }

    return hook || null;
  } catch (e) {
    if (Config.DEBUG) console.log("[MBella] getBellaWebhook failed:", e?.message || e);
    return null;
  }
}

/**
 * sendViaBellaWebhook(client, channel, options)
 *
 * Supports:
 * - username, avatarURL
 * - content, embeds
 * - allowedMentions
 * - components, files
 * - threadId (if sending inside a thread)
 *
 * NOTE:
 * - "reply" / "messageReference" are accepted for compatibility,
 *   but WEBHOOKS cannot do true reply arrows, so they are ignored.
 */
async function sendViaBellaWebhook(
  client,
  channel,
  {
    username,
    avatarURL,
    embeds,
    content,
    allowedMentions,
    components,
    files,
    threadId,

    // accepted but ignored (webhook can't truly reply)
    reply,
    messageReference,
  } = {}
) {
  const hook = await getBellaWebhook(client, channel);
  if (!hook) return { hook: null, message: null };

  try {
    const payload = {
      username: username || Config.MBELLA_NAME,
      avatarURL: avatarURL || Config.MBELLA_AVATAR_URL || undefined,
      embeds,
      content,
      components,
      files,
      // discord.js supports sending into a thread via threadId for webhooks
      ...(threadId ? { threadId: String(threadId) } : {}),
      allowedMentions: allowedMentions || { parse: [] },
    };

    const message = await hook.send(payload);
    return { hook, message };
  } catch (e) {
    // Helpful debug for the REAL reason webhook fails
    if (Config.DEBUG) {
      console.log("[MBella] webhook send failed:", e?.message || e);

      // discord.js REST errors sometimes include rawError or request body details
      try {
        const status = e?.status || e?.httpStatus;
        const code = e?.code;
        const raw = e?.rawError ? JSON.stringify(e.rawError).slice(0, 600) : "";
        console.log(`[MBella] webhook fail details: status=${status || "?"} code=${code || "?"} raw=${raw || "(none)"}`);
      } catch {}
    }

    try {
      client.webhookAuto?.clearChannelCache?.(channel.id);
    } catch {}
    return { hook, message: null };
  }
}

module.exports = {
  getBellaWebhook,
  sendViaBellaWebhook,
};
