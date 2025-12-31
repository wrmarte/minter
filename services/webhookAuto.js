// services/webhookAuto.js
const { PermissionsBitField } = require('discord.js');

// Per-channel cache
const channelWebhookCache = new Map();

/**
 * Get or create a webhook owned by this bot in a channel.
 * Auto-creates if missing.
 */
async function getOrCreateWebhook(channel, {
  name = 'MB Relay',
  avatarURL = null
} = {}) {
  try {
    if (!channel || !channel.guild) return null;

    const cached = channelWebhookCache.get(channel.id);
    if (cached) return cached;

    const me = channel.guild.members.me;
    if (!me) return null;

    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionsBitField.Flags.ManageWebhooks)) return null;

    const hooks = await channel.fetchWebhooks().catch(() => null);

    let hook = hooks?.find(h => h.owner?.id === channel.client.user.id);

    // Refresh name/avatar (safe)
    if (hook) {
      try {
        await hook.edit({
          name,
          avatar: avatarURL || undefined
        });
      } catch {}
    }

    // Create if missing
    if (!hook) {
      hook = await channel.createWebhook({
        name,
        avatar: avatarURL || undefined
      }).catch(() => null);
    }

    if (hook) channelWebhookCache.set(channel.id, hook);
    return hook || null;
  } catch {
    return null;
  }
}

/**
 * Send a message via auto webhook.
 */
async function sendViaWebhook(channel, payload, opts = {}) {
  const hook = await getOrCreateWebhook(channel, opts);
  if (!hook) return false;

  try {
    await hook.send(payload);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getOrCreateWebhook,
  sendViaWebhook
};
