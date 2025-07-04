// ✅ themeFetcher.js
const DEFAULT_BG = '#4e7442';
const DEFAULT_ACCENT = '#294f30';

async function getServerTheme(pg, guildId) {
  try {
    const res = await pg.query(
      'SELECT bg_color, accent_color FROM server_themes WHERE server_id = $1',
      [guildId]
    );
    if (res.rows.length === 0) {
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
