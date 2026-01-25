// listeners/musclemb/context.js
// ======================================================
// Context helper
// - Returns a short system-safe block (guild/channel/user) for grounding.
// - Keep minimal; no message history here (history is handled in listener).
// ======================================================

function safeStr(s, max = 200) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

async function getRecentContext(message) {
  try {
    if (!message?.guild) return '';

    const guildName = safeStr(message.guild.name, 80);
    const channelName = safeStr(message.channel?.name || 'channel', 60);
    const authorName = safeStr(message.member?.displayName || message.author?.username || 'user', 60);

    // very small grounding string
    return `Context: guild="${guildName}", channel="#${channelName}", author="${authorName}".`;
  } catch {
    return '';
  }
}

module.exports = { getRecentContext };
