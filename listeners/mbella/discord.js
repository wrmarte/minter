// listeners/mbella/discord.js
// ======================================================
// Discord helpers: perms, context, reply-to detection, admin check
// ======================================================

const { PermissionsBitField } = require("discord.js");

function isOwnerOrAdmin(message) {
  try {
    const ownerId = String(process.env.BOT_OWNER_ID || "").trim();
    const isOwner = ownerId && message.author?.id === ownerId;
    const isAdmin = Boolean(message.member?.permissions?.has(PermissionsBitField.Flags.Administrator));
    return isOwner || isAdmin;
  } catch {
    return false;
  }
}

function canSendInChannel(guild, channel) {
  const me = guild.members.me;
  if (!me || !channel) return false;
  return channel.isTextBased?.() && channel.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);
}

async function getRecentContext(message) {
  try {
    const fetched = await message.channel.messages.fetch({ limit: 20 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.id === message.id) continue;
      if (m.author?.bot) continue;
      const txt = (m.content || "").trim();
      if (!txt) continue;
      const oneLine = txt.replace(/\s+/g, " ").slice(0, 240);
      lines.push(`${m.author.username}: ${oneLine}`);
      if (lines.length >= 10) break;
    }
    if (!lines.length) return "";
    return `Recent channel context (use it naturally; stay consistent):\n${lines.join("\n")}`.slice(0, 1700);
  } catch {
    return "";
  }
}

async function getReferenceSnippet(message) {
  const ref = message.reference;
  if (!ref?.messageId) return "";
  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);
    const txt = (referenced?.content || "").replace(/\s+/g, " ").trim().slice(0, 320);
    if (!txt) return "";
    return `You are replying to ${referenced.author?.username || "someone"}: "${txt}"`;
  } catch {
    return "";
  }
}

async function isReplyToMBella(message, client, Config) {
  const ref = message.reference;
  if (!ref?.messageId) return false;

  try {
    const referenced = await message.channel.messages.fetch(ref.messageId);

    // Webhook: username is stored on message.author.username for webhook messages in many cases
    if (referenced.webhookId) {
      const uname = String(referenced.author?.username || "").toLowerCase();
      if (uname && uname === String(Config.MBELLA_NAME || "").toLowerCase()) return true;
      if (uname && uname === String(Config.MB_RELAY_WEBHOOK_NAME || "").toLowerCase()) return true;
    }

    // Bot fallback embed author
    if (referenced.author?.id === client.user.id) {
      const embedAuthor = referenced.embeds?.[0]?.author?.name || "";
      if (String(embedAuthor).toLowerCase() === String(Config.MBELLA_NAME || "").toLowerCase()) return true;
    }
  } catch {}

  return false;
}

module.exports = {
  isOwnerOrAdmin,
  canSendInChannel,
  getRecentContext,
  getReferenceSnippet,
  isReplyToMBella,
};
