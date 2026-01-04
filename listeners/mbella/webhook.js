// listeners/mbella/webhook.js
// ======================================================
// Webhook sending helpers (uses client.webhookAuto)
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
      console.log(`[MBella] No webhook returned. ManageWebhooks=${hasMW ? "YES" : "NO"} channel=${channel?.id} guild=${channel?.guild?.id}`);
    }

    return hook || null;
  } catch (e) {
    if (Config.DEBUG) console.log("[MBella] getBellaWebhook failed:", e?.message || e);
    return null;
  }
}

async function sendViaBellaWebhook(client, channel, { username, avatarURL, embeds, content }) {
  const hook = await getBellaWebhook(client, channel);
  if (!hook) return { hook: null, message: null };

  try {
    const message = await hook.send({
      username: username || Config.MBELLA_NAME,
      avatarURL: avatarURL || Config.MBELLA_AVATAR_URL || undefined,
      embeds,
      content,
      allowedMentions: { parse: [] },
    });
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
