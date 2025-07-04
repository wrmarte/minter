// ✅ helpers/themeFetcher.js

const DEFAULT_BG = '#4e7442';
const DEFAULT_ACCENT = '#294f30';

/**
 * Fetches custom theme colors for a server.
 * Falls back to default colors if not found or error occurs.
 * 
 * @param {object} pg - PostgreSQL client
 * @param {string} guildId - Discord guild/server ID
 * @returns {object} { bgColor, accentColor }
 */
async function getServerTheme(pg, guildId) {
  try {
    const res = await pg.query(
      'SELECT bg_color, accent_color FROM server_themes WHERE guild_id = $1',
      [guildId]
    );

    if (res.rows.length === 0) {
      console.log(`🎨 No custom theme found for ${guildId}, using default.`);
      return { bgColor: DEFAULT_BG, accentColor: DEFAULT_ACCENT };
    }

    const { bg_color, accent_color } = res.rows[0];
    return {
      bgColor: bg_color || DEFAULT_BG,
      accentColor: accent_color || DEFAULT_ACCENT
    };
  } catch (err) {
    console.error('❌ Theme fetch error:', err);
    return { bgColor: DEFAULT_BG, accentColor: DEFAULT_ACCENT };
  }
}

module.exports = { getServerTheme };

