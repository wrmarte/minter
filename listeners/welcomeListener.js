// listeners/welcomelisten.js
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

// Optional import: if you created services/welcome.js,
// we'll use it so test path and real joins share the same logic.
let sendWelcomeService = null;
try {
  ({ sendWelcome: sendWelcomeService } = require('../services/welcome'));
} catch {
  // no-op; we'll use the local fallback sender below.
}

/* ======================= Config ======================= */
const TRIGGERS = new Set(['tt-welcome', 'test-welcome']);
const COOLDOWN_MS = 5000;       // per-guild spam guard
const SETTINGS_TTL_MS = 30_000; // cache welcome_settings for 30s

/* =================== In-memory caches =================== */
const guildCooldown = new Map();  // guildId -> lastTimestamp
const settingsCache = new Map();  // guildId -> { data, expiresAt }

/* ======================== Helpers ======================== */
const now = () => Date.now();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

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

/* ============== Local fallback welcome sender ============== */
/* Used only when services/welcome.js is not available */
async function sendWelcomeFallback({ member, guild, cfg }) {
  if (!cfg?.enabled) return;

  const channel = await guild.channels.fetch(cfg.welcome_channel_id).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;

  // Permission check
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me) return;
  const perms = channel.permissionsFor(me);

  const canView = perms?.has(PermissionFlagsBits.ViewChannel);
  const canSend = perms?.has(PermissionFlagsBits.SendMessages);
  const canEmbed = perms?.has(PermissionFlagsBits.EmbedLinks);
  const canManageMessages = perms?.has(PermissionFlagsBits.ManageMessages);

  if (!canView || !canSend) {
    console.log(`[welcome:test] Missing perms (view/send) in channel ${cfg.welcome_channel_id} (guild=${guild.id})`);
    return;
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

  embed.setFooter({ text: 'Powered by Muscle MB • No mercy, only vibes.' });

  // Mentions
  const contentBits = [];
  let pingRoleId = cfg.ping_role_id ? String(cfg.ping_role_id) : null;

  if (pingRoleId && !guild.roles.cache.has(pingRoleId)) {
    try { await guild.roles.fetch(pingRoleId).catch(() => null); } catch {}
  }
  if (pingRoleId && guild.roles.cache.has(pingRoleId)) contentBits.push(`<@&${pingRoleId}>`);
  else pingRoleId = null;

  if (!template.includes('{user_mention}')) contentBits.push(`<@${member.id}>`);

  const allowedMentions = {
    parse: [],
    users: [member.id],
    roles: pingRoleId ? [pingRoleId] : []
  };

  const sent = await channel.send({
    content: contentBits.join(' ') || `🎉 Welcome <@${member.id}> (trigger test)`,
    embeds: canEmbed ? [embed] : undefined,
    allowedMentions
  }).catch(() => null);

  const delSec = Number(cfg.delete_after_sec || 0);
  if (sent && delSec > 0) {
    if (!canManageMessages) {
      console.log(`[welcome:test] delete_after_sec set but missing ManageMessages (guild=${guild.id}, channel=${cfg.welcome_channel_id})`);
    } else {
      setTimeout(() => sent.delete().catch(() => {}), delSec * 1000);
    }
  }

  // For "test" we skip DM to avoid surprising users; enable if you prefer:
  // if (cfg.dm_enabled) await member.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

/* ======================== Listener ======================== */
module.exports = (client, pgFromCaller) => {
  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot || !message.guild) return;

      const raw = String(message.content || '').trim();
      const content = raw.toLowerCase();

      // ✅ Accept exact trigger OR trigger as first token (optional usability)
      const firstToken = content.split(/\s+/)[0];
      if (!TRIGGERS.has(content) && !TRIGGERS.has(firstToken)) return;

      // Per-guild cooldown (spam guard)
      const last = guildCooldown.get(message.guild.id) || 0;
      if (now() - last < COOLDOWN_MS) return;
      guildCooldown.set(message.guild.id, now());

      const pg = pgFromCaller || client.pg;
      if (!pg || typeof pg.query !== 'function') return;

      const guild = message.guild;

      // ✅ Ensure we have a GuildMember for the author
      let member = message.member;
      if (!member) {
        member = await guild.members.fetch(message.author.id).catch(() => null);
      }
      if (!member) return;

      // Load welcome settings (cached)
      const cfg = await getWelcomeSettings(pg, guild.id);
      if (!cfg || !cfg.enabled || !cfg.welcome_channel_id) return;

      // Prefer the shared service to keep behavior identical to real joins
      if (typeof sendWelcomeService === 'function') {
        await sendWelcomeService({ client, pg, member, preview: true });
      } else {
        // Fallback inline sender if the service isn’t present
        await sendWelcomeFallback({ member, guild, cfg });
      }

      // Quick visual confirmation (non-intrusive)
      await message.react('✅').catch(() => {});
    } catch (err) {
      console.error('❌ Welcome trigger error:', err?.stack || err?.message || err);
    }
  });
};

