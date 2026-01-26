// listeners/musclemb/messaging.js
const { PermissionsBitField } = require('discord.js');
const Config = require('./config');
const { markTypingSuppressed } = require('./suppression');

function findSpeakableChannel(guild, preferredChannelId = null) {
  const me = guild.members.me;
  if (!me) return null;

  const canSend = (ch) => {
    if (!ch || !ch.isTextBased?.()) return false;
    const perms = ch.permissionsFor(me);
    if (!perms) return false;

    if (!perms.has(PermissionsBitField.Flags.ViewChannel)) return false;
    if (!perms.has(PermissionsBitField.Flags.SendMessages)) return false;

    if (ch.isThread?.()) {
      if (!perms.has(PermissionsBitField.Flags.SendMessagesInThreads)) return false;
    }

    return true;
  };

  if (preferredChannelId) {
    const ch = guild.channels.cache.get(preferredChannelId);
    if (canSend(ch)) return ch;
  }
  if (guild.systemChannel && canSend(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.find((c) => canSend(c)) || null;
}

function getWebhookAuto(client) {
  return client?.webhookAuto || client?.webhookauto || client?.webhooksAuto || null;
}

/**
 * Determines whether we SHOULD prefer webhook identity for this payload.
 * If username/avatarURL is present, we assume identity matters (pfp/name).
 */
function payloadWantsIdentity(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.username === 'string' && payload.username.trim()) return true;
  if (typeof payload.avatarURL === 'string' && payload.avatarURL.trim()) return true;
  // Optional internal flag (won't break callers): force webhook identity even w/o fields
  if (payload.__forceWebhookIdentity === true) return true;
  return false;
}

/**
 * Normalize webhook identity:
 * - prefer payload username/avatarURL
 * - fallback to MuscleMB config
 */
function resolveIdentity(payload) {
  const username =
    (typeof payload?.username === 'string' && payload.username.trim())
      ? payload.username.trim()
      : (Config.MUSCLEMB_WEBHOOK_NAME || undefined);

  const avatarURL =
    (typeof payload?.avatarURL === 'string' && payload.avatarURL.trim())
      ? payload.avatarURL.trim()
      : (Config.MUSCLEMB_WEBHOOK_AVATAR || undefined);

  return { username, avatarURL };
}

async function sendViaWebhookAuto(client, channel, payload) {
  if (!Config.MB_USE_WEBHOOKAUTO) return false;

  // webhookAuto path generally can’t do files reliably; keep your existing rule
  if (payload?.files && Array.isArray(payload.files) && payload.files.length) return false;

  const wa = getWebhookAuto(client);
  if (!wa) return false;

  const { username, avatarURL } = resolveIdentity(payload);

  const base = {
    content: payload?.content || undefined,
    embeds: payload?.embeds || undefined,
    username,
    avatarURL,
    allowedMentions: payload?.allowedMentions || { parse: [] },
  };

  // ✅ Preferred method: sendViaWebhook(channel, payload, options)
  if (typeof wa.sendViaWebhook === 'function') {
    try {
      const ok = await wa.sendViaWebhook(
        channel,
        base,
        {
          name: username || Config.MUSCLEMB_WEBHOOK_NAME,
          avatarURL: avatarURL || (Config.MUSCLEMB_WEBHOOK_AVATAR || undefined),
        }
      );
      if (ok) return true;
    } catch {
      // fall through
    }
  }

  // Legacy/alternate method names (kept)
  const candidates = [
    wa.send,
    wa.sendMessage,
    wa.post,
    wa.sendToChannel,
    wa.sendWebhook,
    wa.sendWebhookMessage,
  ].filter(fn => typeof fn === 'function');

  if (!candidates.length) return false;

  for (const fn of candidates) {
    try {
      const r = await fn.call(wa, channel, base);
      if (r) return true;

      const r2 = await fn.call(wa, channel.id, base);
      if (r2) return true;

      if (typeof base.content === 'string' && base.content.length) {
        const r3 = await fn.call(wa, channel, base.content);
        if (r3) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function safeSendChannel(client, channel, payload) {
  // If files, always use normal send
  if (payload?.files && Array.isArray(payload.files) && payload.files.length) {
    try {
      await channel.send(payload);
      return true;
    } catch (e) {
      console.warn('❌ channel.send (files) failed:', e?.message || String(e));
      return false;
    }
  }

  // ✅ If identity requested OR webhookAuto enabled, try webhook first
  // Identity requested is important for MB avatar.
  if (Config.MB_USE_WEBHOOKAUTO) {
    const ok = await sendViaWebhookAuto(client, channel, payload);
    if (ok) {
      try { markTypingSuppressed(client, channel.id, 9000); } catch {}
      return true;
    }
  }

  // fallback
  try {
    await channel.send(payload);
    return true;
  } catch (e) {
    console.warn('❌ channel.send failed:', e?.message || String(e));
    return false;
  }
}

async function safeReplyMessage(client, message, payload) {
  // If files, reply normally (webhooks are messy with attachments)
  if (payload?.files && Array.isArray(payload.files) && payload.files.length) {
    try {
      await message.reply(payload);
      return true;
    } catch {
      try {
        await message.channel.send(payload);
        return true;
      } catch (e2) {
        console.warn('❌ reply/channel send (files) failed:', e2?.message || String(e2));
        return false;
      }
    }
  }

  const wa = getWebhookAuto(client);

  // ✅ NEW RULE:
  // If webhookAuto exists and either:
  // - caller wants identity (username/avatarURL present), OR
  // - config says use webhookAuto for replies,
  // then route reply through channel webhook path.
  const wantsIdentity = payloadWantsIdentity(payload);
  const shouldUseWebhook = Boolean(Config.MB_USE_WEBHOOKAUTO && wa) && (wantsIdentity || Config.MB_USE_WEBHOOKAUTO);

  if (shouldUseWebhook) {
    const prefix = (Config.MB_WEBHOOK_PREFIX_AUTHOR && message?.author?.username)
      ? `↪️ **${message.author.username}**: `
      : '';

    const asChannelPayload = { ...payload };

    // Build a visible “reply-ish” prefix for webhook messages
    if (typeof asChannelPayload.content === 'string' && asChannelPayload.content.length) {
      asChannelPayload.content = prefix + asChannelPayload.content;
    } else if (!asChannelPayload.content && asChannelPayload?.embeds?.length) {
      asChannelPayload.content = prefix.trim() || undefined;
    } else if (!asChannelPayload.content) {
      asChannelPayload.content = prefix.trim() || undefined;
    }

    // ✅ Respect caller identity first, else default to MuscleMB config
    const { username, avatarURL } = resolveIdentity(asChannelPayload);

    // Never allow pings on webhook replies
    return await safeSendChannel(client, message.channel, {
      ...asChannelPayload,
      allowedMentions: { parse: [] },
      username,
      avatarURL,
    });
  }

  // fallback to normal reply
  try {
    await message.reply(payload);
    return true;
  } catch {
    try {
      await message.channel.send(payload);
      return true;
    } catch (e2) {
      console.warn('❌ reply/channel send failed:', e2?.message || String(e2));
      return false;
    }
  }
}

module.exports = {
  findSpeakableChannel,
  safeSendChannel,
  safeReplyMessage,
  getWebhookAuto,
};

