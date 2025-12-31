// services/welcome.js
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

function fmt(tpl, { member, guild, memberCount }) {
  const user = member.user;
  const safe = (v) => (v == null ? '' : String(v));
  return safe(tpl || '')
    .replaceAll('{user}', safe(user.username))
    .replaceAll('{user_tag}', safe(user.tag || `${user.username}`))
    .replaceAll('{user_id}', safe(user.id))
    .replaceAll('{user_mention}', `<@${user.id}>`)
    .replaceAll('{server}', safe(guild.name))
    .replaceAll('{server_id}', safe(guild.id))
    .replaceAll('{member_count}', safe(memberCount));
}

function safeAvatar(member) {
  try {
    return (
      member?.displayAvatarURL?.({ size: 256 }) ||
      member?.user?.displayAvatarURL?.({ size: 256 }) ||
      null
    );
  } catch {
    return null;
  }
}

function safeHttpUrl(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

async function getMemberCount(guild) {
  // Prefer the built-in count; avoid heavy member fetches.
  try {
    if (Number.isFinite(guild.memberCount) && guild.memberCount > 0) return guild.memberCount;
  } catch {}
  try {
    const refreshed = await guild.fetch().catch(() => null);
    if (refreshed && Number.isFinite(refreshed.memberCount) && refreshed.memberCount > 0) return refreshed.memberCount;
  } catch {}
  return 'N/A';
}

async function sendWelcome({ client, pg, member, overrideChannelId = null, preview = false }) {
  if (!pg || typeof pg.query !== 'function') return;
  if (!member?.guild) return;

  const guild = member.guild;
  const gid = guild.id;

  // Load config (limit 1 in case of duplicates)
  let cfg = null;
  try {
    const { rows } = await pg.query(
      `
      SELECT enabled, welcome_channel_id, dm_enabled, delete_after_sec,
             message_template, image_url, ping_role_id
      FROM welcome_settings
      WHERE guild_id = $1
      LIMIT 1
      `,
      [gid]
    );
    if (!rows?.length) return;
    cfg = rows[0];
  } catch (e) {
    console.log(`[welcome] DB read failed (guild=${gid}):`, e?.message || e);
    return;
  }

  if (!cfg?.enabled && !preview) return;

  const channelId = overrideChannelId || cfg.welcome_channel_id;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;

  // Permissions
  const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!me) return;

  const perms = channel.permissionsFor(me);
  const canView = perms?.has(PermissionFlagsBits.ViewChannel);
  const canSend = perms?.has(PermissionFlagsBits.SendMessages);
  const canEmbed = perms?.has(PermissionFlagsBits.EmbedLinks);

  if (!canView || !canSend) {
    console.log(`[welcome] Missing perms (view/send) in channel ${channelId} (guild=${gid})`);
    return;
  }
  if (!canEmbed) {
    console.log(`[welcome] Missing EmbedLinks in channel ${channelId} (guild=${gid}) — sending plain text only`);
  }

  const memberCount = await getMemberCount(guild);

  const template =
    (cfg.message_template && String(cfg.message_template).trim().length)
      ? String(cfg.message_template)
      : '👋 Welcome {user_mention} to **{server}**!';

  const description = fmt(template, { member, guild, memberCount });

  const embed = new EmbedBuilder()
    .setTitle('🌊 A New Member Has Surfaced')
    .setDescription(description.slice(0, 4096))
    .setTimestamp();

  const avatar = safeAvatar(member);
  if (avatar) embed.setThumbnail(avatar);

  const img = safeHttpUrl(cfg.image_url);
  if (img) embed.setImage(img);

  // Content pings (role + user if template didn't include user mention)
  const contentBits = [];

  // Only mention role if it exists in the guild
  let pingRoleId = cfg.ping_role_id ? String(cfg.ping_role_id) : null;
  if (pingRoleId && !guild.roles.cache.has(pingRoleId)) {
    // best-effort: fetch role cache if not present
    try { await guild.roles.fetch(pingRoleId).catch(() => null); } catch {}
  }
  if (pingRoleId && guild.roles.cache.has(pingRoleId)) {
    contentBits.push(`<@&${pingRoleId}>`);
  } else {
    pingRoleId = null;
  }

  const templateHasUserMention = template.includes('{user_mention}');
  if (!templateHasUserMention) contentBits.push(`<@${member.id}>`);

  // Prevent accidental mass pings in templates
  const allowedMentions = {
    parse: [],
    users: [member.id],
    roles: pingRoleId ? [pingRoleId] : []
  };

  const payload = {
    content: contentBits.join(' ') || undefined,
    embeds: canEmbed ? [embed] : undefined,
    allowedMentions
  };

  const msg = await channel.send(payload).catch(() => null);

  // Auto-delete if configured (only if we can manage messages)
  const delSec = Number(cfg.delete_after_sec || 0);
  const canManageMessages = perms?.has(PermissionFlagsBits.ManageMessages);

  if (msg && delSec > 0 && !preview) {
    if (!canManageMessages) {
      console.log(`[welcome] delete_after_sec set but missing ManageMessages in channel ${channelId} (guild=${gid})`);
    } else {
      setTimeout(() => msg.delete().catch(() => {}), delSec * 1000);
    }
  }

  // DM only on real joins (skip for previews)
  if (cfg.dm_enabled && !preview) {
    try {
      // DM should not ping roles; keep it clean
      await member.send({
        embeds: [embed],
        allowedMentions: { parse: [] }
      }).catch(() => {});
    } catch {}
  }
}

module.exports = { sendWelcome };

