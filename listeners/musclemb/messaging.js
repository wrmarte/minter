// listeners/musclemb/messaging.js
const { PermissionsBitField } = require('discord.js');
const Config = require('./config');
const { markTypingSuppressed } = require('./suppression');

function findSpeakableChannel(guild, preferredChannelId = null) {
  const me = guild.members.me;
  if (!me) return null;

  const canSend = (ch) =>
    ch &&
    ch.isTextBased?.() &&
    ch.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);

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

async function sendViaWebhookAuto(client, channel, payload) {
  if (!Config.MB_USE_WEBHOOKAUTO) return false;
  if (payload?.files && Array.isArray(payload.files) && payload.files.length) return false;

  const wa = getWebhookAuto(client);
  if (!wa) return false;

  const candidates = [
    wa.send,
    wa.sendMessage,
    wa.post,
    wa.sendToChannel,
    wa.sendWebhook,
    wa.sendWebhookMessage,
  ].filter(fn => typeof fn === 'function');

  if (!candidates.length) return false;

  const base = {
    content: payload?.content || undefined,
    embeds: payload?.embeds || undefined,
    username: payload?.username || Config.MUSCLEMB_WEBHOOK_NAME,
    avatarURL: payload?.avatarURL || (Config.MUSCLEMB_WEBHOOK_AVATAR || undefined),
    allowedMentions: payload?.allowedMentions || { parse: [] },
  };

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
  if (payload?.files && Array.isArray(payload.files) && payload.files.length) {
    try {
      await channel.send(payload);
      return true;
    } catch (e) {
      console.warn('❌ channel.send (files) failed:', e?.message || String(e));
      return false;
    }
  }

  const ok = await sendViaWebhookAuto(client, channel, payload);
  if (ok) {
    try { markTypingSuppressed(client, channel.id, 9000); } catch {}
    return true;
  }

  try {
    await channel.send(payload);
    return true;
  } catch (e) {
    console.warn('❌ channel.send failed:', e?.message || String(e));
    return false;
  }
}

async function safeReplyMessage(client, message, payload) {
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
  if (Config.MB_USE_WEBHOOKAUTO && wa) {
    const prefix = (Config.MB_WEBHOOK_PREFIX_AUTHOR && message?.author?.username)
      ? `↪️ **${message.author.username}**: `
      : '';
    const asChannelPayload = { ...payload };

    if (typeof asChannelPayload.content === 'string' && asChannelPayload.content.length) {
      asChannelPayload.content = prefix + asChannelPayload.content;
    } else if (!asChannelPayload.content && payload?.embeds?.length) {
      asChannelPayload.content = prefix.trim() || undefined;
    } else if (!asChannelPayload.content) {
      asChannelPayload.content = prefix.trim() || undefined;
    }

    return await safeSendChannel(client, message.channel, {
      ...asChannelPayload,
      allowedMentions: { parse: [] },
      username: Config.MUSCLEMB_WEBHOOK_NAME,
      avatarURL: Config.MUSCLEMB_WEBHOOK_AVATAR || undefined,
    });
  }

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
