// listeners/musclemb/context.js
async function getRecentContext(message) {
  try {
    const fetched = await message.channel.messages.fetch({ limit: 8 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.id === message.id) continue;
      if (m.author?.bot) continue;
      const txt = (m.content || '').trim();
      if (!txt) continue;
      const oneLine = txt.replace(/\s+/g, ' ').slice(0, 200);
      lines.push(`${m.author.username}: ${oneLine}`);
      if (lines.length >= 6) break;
    }
    if (!lines.length) return '';
    const joined = lines.join('\n');
    return `Recent context:\n${joined}`.slice(0, 1200);
  } catch {
    return '';
  }
}

module.exports = { getRecentContext };
