// listeners/mbella/webhook.js
// ======================================================
// Webhook sending helpers (uses client.webhookAuto)
// ✅ Patch: stronger reply/messageReference normalization for webhook sends
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
 * - reply (Discord reply arrow)  -> { messageReference: "<messageId>", failIfNotExists?: false }
 * - messageReference shortcut     -> "<messageId>" OR { messageId, failIfNotExists? }
 * - components, files
 * - threadId (if sending inside a thread)
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
    reply,
    messageReference,
    components,
    files,
    threadId,
  } = {}
) {
  const hook = await getBellaWebhook(client, channel);
  if (!hook) return { hook: null, message: null };

  try {
    // ✅ Normalize messageReference into a reply object (discord.js-friendly)
    // Accept:
    // - messageReference: "123"
    // - messageReference: { messageId: "123", failIfNotExists: false }
    // - reply: { messageReference: "123", failIfNotExists: false }
    let finalReply = undefined;

    if (reply && typeof reply === "object") {
      // Already in reply format
      finalReply = reply;
    } else if (typeof messageReference === "string" && messageReference.trim()) {
      finalReply = { messageReference: String(messageReference), failIfNotExists: false };
    } else if (messageReference && typeof messageReference === "object") {
      const mid = messageReference.messageId || messageReference.messageReference;
      if (mid) {
        finalReply = {
          messageReference: String(mid),
          failIfNotExists: messageReference.failIfNotExists === true ? true : false,
        };
      }
    }

    // ✅ Strong default: never ping, never ping replied user
    const finalAllowedMentions =
      allowedMentions || { parse: [], repliedUser: false };

    // If caller passed allowedMentions but forgot repliedUser, force safe default
    if (finalAllowedMentions && typeof finalAllowedMentions === "object" && finalAllowedMentions.repliedUser == null) {
      finalAllowedMentions.repliedUser = false;
    }

    const payload = {
      username: username || Config.MBELLA_NAME,
      avatarURL: avatarURL || Config.MBELLA_AVATAR_URL || undefined,
      embeds,
      content,
      components,
      files,
      threadId,

      // ✅ This is the key for native reply arrow in discord.js send options
      reply: finalReply,

      allowedMentions: finalAllowedMentions,
    };

    if (Config.DEBUG) {
      const rmid = payload?.reply?.messageReference ? String(payload.reply.messageReference) : "";
      console.log(
        `[MBella] webhook send -> channel=${channel?.id} reply=${rmid ? "YES:" + rmid : "NO"} threadId=${threadId || ""}`
      );
    }

    const message = await hook.send(payload);
    return { hook, message };
  } catch (e) {
    if (Config.DEBUG) console.log("[MBella] webhook send failed:", e?.message || e);
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
