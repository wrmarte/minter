// services/welcome.js
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

function fmt(tpl, { member, guild, memberCount }) {
  const user = member.user;
  return String(tpl || '')
    .replaceAll('{user}', user.username)
    .replaceAll('{user_mention}', `<@${user.id}>`)
    .replaceAll('{server}', guild.name)
    .replaceAll('{member_count}', `${memberCount}`);
}

function safeAvatar(member) {
  try {
    return (
      member?.displayAvatarURL?.({ size: 256 }) ||
      member?.user?.displayAvatarURL?.({ size: 256 }) ||
      null
    );
  } catch { return null; }
}

async function sendWelcome({ client, pg, member, overrideChannelId = null, preview = false }) {
  const guild = member.guild;
  const gid = guild.id;

  // Load config
  const { rows } = await pg.query(`
    SELECT enabled, welcome_channel_id, dm_enabled, delete_after_sec,
           message_template, image_url, ping_role_id
    FROM welcome_settings WHERE guild_id = $1
  `, [gid]);
  if (!rows.length) return;
  const cfg = rows[0];
  if (!cfg.enabled) return;

  const channelId = overrideChannelId || cfg.welcome_channel_id;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // Permissions
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
    console.log(`[welcome] Missing perms in channel ${channelId} (guild=${gid})`);
    return;
  }

  const memberCount = guild.memberCount ?? (await guild.members.fetch()).size;

  const template = (cfg.message_template && cfg.message_template.trim().length)
    ? cfg.message_template
    : '👋 Welcome {user_mention} to **{server}**!';

  const description = fmt(template, { member, guild, memberCount });

  const embed = new EmbedBuilder()
    .setTitle(`🌊 A New Member Has Surfaced`)
    .setDescription(description)
    .setTimestamp();

  const avatar = safeAvatar(member);
  if (avatar) embed.setThumbnail(avatar);
  if (cfg.image_url) embed.setImage(cfg.image_url);

  const contentBits = [];
  if (cfg.ping_role_id) contentBits.push(`<@&${cfg.ping_role_id}>`);
  if (!template.includes('{user_mention}')) contentBits.push(`<@${member.id}>`);

  const msg = await channel.send({
    content: contentBits.join(' ') || undefined,
    embeds: [embed]
  }).catch(() => null);

  if (msg && cfg.delete_after_sec && cfg.delete_after_sec > 0 && !preview) {
    setTimeout(() => msg.delete().catch(() => {}), cfg.delete_after_sec * 1000);
  }

  // DM only on real joins (skip for previews unless you want it)
  if (cfg.dm_enabled && !preview) {
    await member.send({ embeds: [embed] }).catch(() => {});
  }
}

module.exports = { sendWelcome };
