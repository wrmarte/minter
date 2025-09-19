// listeners/welcomelisten.js
const { EmbedBuilder } = require('discord.js');

// Optional import: if you created services/welcome.js from earlier steps,
// we'll use it so the test path and the real join path share the same logic.
let sendWelcomeService = null;
try {
  ({ sendWelcome: sendWelcomeService } = require('../services/welcome'));
} catch {
  // services/welcome not present; we'll use the local fallback sender below.
}

// ---------- Config ----------
const TRIGGERS = new Set(['tt-welcome', 'test-welcome']);
const COOLDOWN_MS = 5000;         // per-guild spam guard
const SETTINGS_TTL_MS = 30_000;   // cache welcome_settings for 30s

// ---------- In-memory caches ----------
const guildCooldown = new Map(); // guildId -> lastTimestamp
const settingsCache = new Map(); // guildId -> { data, expiresAt }

// ---------- Helpers ----------
function now() { return Date.now(); }

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
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

async function getWelcomeSettings(pg, guildId) {
  const cached = settingsCache.get(guildId);
  if (cached && cached.expiresAt > now()) return cached.data;

  const { rows } = await pg.query(
    `SELECT enabled, welcome_channel_id, dm_enabled, delete_after_sec,
            message_template, image_url, ping_role_id
     FROM welcome_settings
     WHERE guild_id = $1`,
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
    .replaceAll('{user_mention}', `<@${user.id}>`)
    .replaceAll('{server}', `${guild.name}`)
    .replaceAll('{member_count}', `${memberCount}`);
}

// Local fallback sender used only if services/welcome.js is not available
async function sendWelcomeFallback({ member, guild, cfg }) {
  if (!cfg?.enabled) return;

  const channel = await guild.channels.fetch(cfg.welcome_channel_id).catch(() => null);
  if (!channel) return;

  const memberCount = guild.memberCount ?? (await guild.members.fetch()).size;

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

  const template = cfg.message_template && cfg.message_template.trim().length > 0
    ? cfg.message_template
    : pick(defaults);

  const description = formatTemplate(template, { member, guild, memberCount });

  const embed = new EmbedBuilder()
    .setTitle(`🌊 A New Member Has Surfaced`)
    .setDescription(description)
    .setColor(pick(colors))
    .setTimestamp();

  const avatarUrl = safeAvatar(member);
  if (avatarUrl) embed.setThumbnail(avatarUrl);
  if (cfg.image_url) embed.setImage(cfg.image_url);
  embed.setFooter({ text: 'Powered by Muscle MB • No mercy, only vibes.' });

  const contentBits = [];
  if (cfg.ping_role_id) contentBits.push(`<@&${cfg.ping_role_id}>`);
  // if template didn't mention the user, tag them in content for visibility
  if (!template.includes('{user_mention}')) contentBits.push(`<@${member.id}>`);

  const sent = await channel.send({
    content: contentBits.join(' ') || `🎉 Welcome <@${member.id}> (trigger test)`,
    embeds: [embed],
  }).catch(() => null);

  if (sent && cfg.delete_after_sec && cfg.delete_after_sec > 0) {
    setTimeout(() => sent.delete().catch(() => {}), cfg.delete_after_sec * 1000);
  }

  // For "test" we usually skip DM to avoid surprising users; uncomment if desired:
  // if (cfg.dm_enabled) {
  //   await member.send({ embeds: [embed] }).catch(() => {});
  // }
}

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot || !message.guild) return;

      const content = message.content.trim().toLowerCase();
      if (!TRIGGERS.has(content)) return;

      // Per-guild cooldown (spam guard)
      const last = guildCooldown.get(message.guild.id) || 0;
      if (now() - last < COOLDOWN_MS) return;
      guildCooldown.set(message.guild.id, now());

      const pg = client.pg;
      const guild = message.guild;
      const member = message.member;

      // Load welcome settings (cached)
      const cfg = await getWelcomeSettings(pg, guild.id);
      if (!cfg || !cfg.enabled || !cfg.welcome_channel_id) {
        // Silent return if not configured; or you can inform admins only:
        // if (message.member.permissions.has('Administrator')) {
        //   message.reply({ content: '⚠️ Welcome isn’t configured. Use /setwelcome first.', allowedMentions: { repliedUser: false } }).catch(() => {});
        // }
        return;
      }

      // Prefer the shared service if available (keeps behavior identical to real joins)
      if (typeof sendWelcomeService === 'function') {
        await sendWelcomeService({ client, pg, member });
      } else {
        // Fallback inline sender if the service isn’t present
        await sendWelcomeFallback({ member, guild, cfg });
      }

      // Quick visual confirmation (non-intrusive)
      await message.react('✅').catch(() => {});
    } catch (err) {
      console.error('❌ Welcome trigger error:', err);
    }
  });
};

