// listeners/welcomeListener.js
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

/* ======================= Config ======================= */
const TRIGGERS = new Set(['tt-welcome', 'test-welcome']);
const COOLDOWN_MS = 5000;       // per-guild spam guard
const SETTINGS_TTL_MS = 30_000; // cache welcome_settings for 30s

/* =================== In-memory caches =================== */
const guildCooldown = new Map();  // guildId -> lastTimestamp
const settingsCache = new Map();  // guildId -> { data, expiresAt }

const now = () => Date.now();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* ======================== Helpers ======================== */
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

async function ensureWelcomeSchema(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS welcome_settings (
      guild_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT false,
      welcome_channel_id TEXT,
      dm_enabled BOOLEAN NOT NULL DEFAULT false,
      delete_after_sec INT,
      message_template TEXT,
      image_url TEXT,
      ping_role_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getWelcomeSettings(pg, guildId) {
  const cached = settingsCache.get(guildId);
  if (cached && cached.expiresAt > now()) return cached.data;

  const { rows } = await pg.query(
    `SELECT enabled, welcome_channel_id, dm_enabled, delete_after_sec,
            message_template, image_url, ping_role_id
     FROM welcome_settings
     WHERE guild_id = $1
     LIMIT 1`,
    [guildId]
  );

  const data = rows[0] || null;
  settingsCache.set(guildId, { data, expiresAt: now() + SETTINGS_TTL_MS });
  return data;
}

function formatTemplate(tpl, { member, guild, memberCount }) {
  const user = member.user;
  return String(tpl || '')
    .replaceAll('{user}', `${user.username}`)
    .replaceAll('{user_tag}', `${user.tag || user.username}`)
    .replaceAll('{user_id}', `${user.id}`)
    .replaceAll('{user_mention}', `<@${user.id}>`)
    .replaceAll('{server}', `${guild.name}`)
    .replaceAll('{server_id}', `${guild.id}`)
    .replaceAll('{member_count}', `${memberCount}`);
}

async function getMemberCountSafe(guild) {
  try {
    if (Number.isFinite(guild.memberCount) && guild.memberCount > 0) return guild.memberCount;
  } catch {}
  try {
    const refreshed = await guild.fetch().catch(() => null);
    if (refreshed && Number.isFinite(refreshed.memberCount) && refreshed.memberCount > 0) return refreshed.memberCount;
  } catch {}
  return 'N/A';
}

function safeHttpUrl(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

async function sendWelcome({ client, pg, member, guild, cfg, reason = 'join' }) {
  if (!cfg?.enabled) return false;
  if (!cfg.welcome_channel_id) return false;

  const channel = await guild.channels.fetch(cfg.welcome_channel_id).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return false;

  // Permission check
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me) return false;
  const perms = channel.permissionsFor(me);

  const canView = perms?.has(PermissionFlagsBits.ViewChannel);
  const canSend = perms?.has(PermissionFlagsBits.SendMessages);
  const canEmbed = perms?.has(PermissionFlagsBits.EmbedLinks);
  const canManageMessages = perms?.has(PermissionFlagsBits.ManageMessages);

  if (!canView || !canSend) {
    console.log(`[welcome] Missing perms (view/send) in channel ${cfg.welcome_channel_id} (guild=${guild.id})`);
    return false;
  }

  const memberCount = await getMemberCountSafe(guild);

  const colors = ['#00FF99', '#FF69B4', '#FFD700', '#7289DA', '#FF4500', '#00BFFF', '#8A2BE2'];
  const emojis = ['🌀', '🎯', '🔥', '👑', '🛸', '🚀', '💀', '😈', '🍄', '🎮'];
  const defaults = [
    `Welcome to the lair, {user_mention}! ${pick(emojis)}`,
    `They made it! {user_mention} just landed 🛬`,
    `🎉 Fresh meat has arrived: {user_mention}`,
    `⚔️ {user_mention} enters the arena. Let the games begin.`,
    `👾 Welcome {user_mention}, may the gas be ever in your favor.`,
    `💥 {user_mention} just joined the most degen guild on Discord.`,
    `📦 {user_mention} dropped in with the alpha. Give 'em love.`,
  ];

  const template = (cfg.message_template && String(cfg.message_template).trim().length > 0)
    ? String(cfg.message_template)
    : pick(defaults);

  const description = formatTemplate(template, { member, guild, memberCount });

  const embed = new EmbedBuilder()
    .setTitle('🌊 A New Member Has Surfaced')
    .setDescription(description.slice(0, 4096))
    .setColor(pick(colors))
    .setTimestamp();

  const avatarUrl = safeAvatar(member);
  if (avatarUrl) embed.setThumbnail(avatarUrl);

  const img = safeHttpUrl(cfg.image_url);
  if (img) embed.setImage(img);

  embed.setFooter({ text: 'Powered by MuscleMB • No mercy, only vibes.' });

  // Mentions
  const contentBits = [];
  let pingRoleId = cfg.ping_role_id ? String(cfg.ping_role_id) : null;

  if (pingRoleId && !guild.roles.cache.has(pingRoleId)) {
    try { await guild.roles.fetch(pingRoleId).catch(() => null); } catch {}
  }
  if (pingRoleId && guild.roles.cache.has(pingRoleId)) contentBits.push(`<@&${pingRoleId}>`);
  else pingRoleId = null;

  // Ensure the new member gets mentioned even if template doesn't include it
  if (!template.includes('{user_mention}')) contentBits.push(`<@${member.id}>`);

  const allowedMentions = {
    parse: [],
    users: [member.id],
    roles: pingRoleId ? [pingRoleId] : []
  };

  const sent = await channel.send({
    content: contentBits.join(' ') || `🎉 Welcome <@${member.id}>`,
    embeds: canEmbed ? [embed] : undefined,
    allowedMentions
  }).catch((e) => {
    console.warn(`[welcome] send failed (guild=${guild.id}, reason=${reason}):`, e?.message || e);
    return null;
  });

  const delSec = Number(cfg.delete_after_sec || 0);
  if (sent && delSec > 0) {
    if (!canManageMessages) {
      console.log(`[welcome] delete_after_sec set but missing ManageMessages (guild=${guild.id}, channel=${cfg.welcome_channel_id})`);
    } else {
      setTimeout(() => sent.delete().catch(() => {}), delSec * 1000);
    }
  }

  return Boolean(sent);
}

/* ======================== Listener ======================== */
module.exports = (client, pgFromCaller) => {
  // ✅ REAL NEW MEMBER WELCOME (this is what you were missing)
  client.on('guildMemberAdd', async (member) => {
    try {
      const guild = member.guild;
      if (!guild) return;

      const last = guildCooldown.get(guild.id) || 0;
      if (now() - last < COOLDOWN_MS) return;
      guildCooldown.set(guild.id, now());

      const pg = pgFromCaller || client.pg;
      if (!pg?.query) return;

      await ensureWelcomeSchema(pg).catch(() => {});
      const cfg = await getWelcomeSettings(pg, guild.id);
      if (!cfg || !cfg.enabled) return;

      await sendWelcome({ client, pg, member, guild, cfg, reason: 'join' });
    } catch (err) {
      console.error('❌ Welcome join error:', err?.stack || err?.message || err);
    }
  });

  // ✅ OPTIONAL: text trigger tests (kept)
  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot || !message.guild) return;

      const raw = String(message.content || '').trim();
      const content = raw.toLowerCase();
      const firstToken = content.split(/\s+/)[0];
      if (!TRIGGERS.has(content) && !TRIGGERS.has(firstToken)) return;

      const last = guildCooldown.get(message.guild.id) || 0;
      if (now() - last < COOLDOWN_MS) return;
      guildCooldown.set(message.guild.id, now());

      const pg = pgFromCaller || client.pg;
      if (!pg?.query) return;

      const guild = message.guild;

      let member = message.member;
      if (!member) member = await guild.members.fetch(message.author.id).catch(() => null);
      if (!member) return;

      await ensureWelcomeSchema(pg).catch(() => {});
      const cfg = await getWelcomeSettings(pg, guild.id);
      if (!cfg || !cfg.enabled) return;

      await sendWelcome({ client, pg, member, guild, cfg, reason: 'trigger' });

      await message.react('✅').catch(() => {});
    } catch (err) {
      console.error('❌ Welcome trigger error:', err?.stack || err?.message || err);
    }
  });
};

