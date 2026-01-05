// listeners/mbella/discord.js
// ======================================================
// Discord helpers: perms, context, reply-to detection, admin check
// ======================================================

const { PermissionsBitField } = require("discord.js");

function lc(v) {
  return String(v || "").trim().toLowerCase();
}

function isOwnerOrAdmin(message) {
  try {
    const ownerId = String(process.env.BOT_OWNER_ID || "").trim();
    const isOwner = ownerId && message.author?.id === ownerId;
    const isAdmin = Boolean(
      message.member?.permissions?.has(PermissionsBitField.Flags.Administrator)
    );
    return isOwner || isAdmin;
  } catch {
    return false;
  }
}

function canSendInChannel(guild, channel) {
  try {
    const me = guild.members.me;
    if (!me || !channel) return false;
    if (!channel.isTextBased?.()) return false;

    const perms = channel.permissionsFor(me);
    if (!perms) return false;

    // Keep it lightweight but safe
    return (
      perms.has(PermissionsBitField.Flags.ViewChannel) &&
      perms.has(PermissionsBitField.Flags.SendMessages)
    );
  } catch {
    return false;
  }
}

async function getRecentContext(message) {
  try {
    const fetched = await message.channel.messages.fetch({ limit: 20 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.id === message.id) continue;
      if (m.author?.bot) continue; // skip bots + webhooks
      const txt = (m.content || "").trim();
      if (!txt) continue;
      const oneLine = txt.replace(/\s+/g, " ").slice(0, 240);
      lines.push(`${m.author.username}: ${oneLine}`);
      if (lines.length >= 10) break;
    }
    if (!lines.length) return "";
    return `Recent channel context (use it naturally; stay consistent):\n${lines.join("\n")}`.slice(
      0,
      1700
    );
  } catch {
    return "";
  }
}

async function getReferenceSnippet(message) {
  const ref = message.reference;
  if (!ref?.messageId) return "";

  // Prefer repliedUser (doesn't require history fetch)
  try {
    const replied = message.mentions?.repliedUser;
    if (replied) {
      const uname = replied.username || replied.globalName || "someone";
      const txt = String(message.content || "").replace(/\s+/g, " ").trim().slice(0, 320);
      // We don't know the referenced text without fetch, but we can still convey the intent:
      return `You are replying to ${uname}. (Reply context inferred from Discord)`;
    }
  } catch {}

  // Fetch text if possible (requires Read Message History)
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);
    const txt = (referenced?.content || "").replace(/\s+/g, " ").trim().slice(0, 320);
    if (!txt) return "";
    return `You are replying to ${referenced.author?.username || "someone"}: "${txt}"`;
  } catch {
    return "";
  }
}

/**
 * Robust reply-to detection for MBella messages.
 *
 * Works for:
 * - MBella webhook messages (webhookId + username)
 * - MBella embed messages (embed author.name = MBella)
 * - Cases where Read Message History is missing (uses mentions.repliedUser)
 *
 * Optional envs (if you want extra hard-matching later):
 * - MBELLA_WEBHOOK_ID
 * - MB_RELAY_WEBHOOK_ID
 */
async function isReplyToMBella(message, client, Config) {
  const ref = message.reference;
  if (!ref?.messageId) return false;

  const bellaName = lc(Config?.MBELLA_NAME);
  const relayName = lc(Config?.MB_RELAY_WEBHOOK_NAME);
  const envBellaHookId = lc(process.env.MBELLA_WEBHOOK_ID || "");
  const envRelayHookId = lc(process.env.MB_RELAY_WEBHOOK_ID || "");

  // ✅ Fast path: repliedUser exists (no fetch needed)
  // NOTE: For webhook messages, Discord often still provides repliedUser.username = webhook name.
  try {
    const replied = message.mentions?.repliedUser;
    if (replied) {
      const ru = lc(replied.username || replied.globalName);
      if (ru && (ru === bellaName || (relayName && ru === relayName))) return true;
    }
  } catch {}

  // ✅ Fetch referenced message (best effort)
  try {
    // If reference has channelId and differs (rare), try that channel.
    let channel = message.channel;
    const refChannelId = String(ref.channelId || "");
    if (refChannelId && refChannelId !== String(message.channel.id)) {
      const other =
        message.guild?.channels?.cache?.get(refChannelId) ||
        (await message.guild?.channels?.fetch(refChannelId).catch(() => null));
      if (other?.isTextBased?.()) channel = other;
    }

    const referenced = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (!referenced) return false;

    const refWebhookId = lc(referenced.webhookId || "");

    // ✅ If this was sent by a webhook, identify by webhook name + embed author + optional webhookId env
    if (referenced.webhookId) {
      const au = lc(referenced.author?.username);
      const ag = lc(referenced.author?.globalName);

      if (envBellaHookId && refWebhookId && refWebhookId === envBellaHookId) return true;
      if (envRelayHookId && refWebhookId && refWebhookId === envRelayHookId) return true;

      if (au && (au === bellaName || (relayName && au === relayName))) return true;
      if (ag && (ag === bellaName || (relayName && ag === relayName))) return true;

      // Also check embed author name because your webhook sends embeds with author.name = MBella
      const embAuthor = lc(referenced.embeds?.[0]?.author?.name);
      if (embAuthor && embAuthor === bellaName) return true;

      // Some webhook messages might be "…" placeholder; still count as Bella if embed author matches
      const content = lc(referenced.content);
      if (content === "…" && (au === bellaName || embAuthor === bellaName)) return true;
    }

    // ✅ If it was sent by the bot user (fallback path)
    if (referenced.author?.id && client?.user?.id && referenced.author.id === client.user.id) {
      const embAuthor = lc(referenced.embeds?.[0]?.author?.name);
      if (embAuthor && embAuthor === bellaName) return true;
    }

    // ✅ Final fallback: any embed author name "MBella" counts
    const embAuthorAny = lc(referenced.embeds?.[0]?.author?.name);
    if (embAuthorAny && embAuthorAny === bellaName) return true;

    return false;
  } catch {
    // If we can't fetch (missing Read Message History), rely on repliedUser path above.
    return false;
  }
}

module.exports = {
  isOwnerOrAdmin,
  canSendInChannel,
  getRecentContext,
  getReferenceSnippet,
  isReplyToMBella,
};
