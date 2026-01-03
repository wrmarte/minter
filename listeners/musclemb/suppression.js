// listeners/musclemb/suppression.js
function isTypingSuppressed(client, channelId) {
  const until = client.__mbTypingSuppress?.get(channelId) || 0;
  return Date.now() < until;
}

function markTypingSuppressed(client, channelId, ms = 11000) {
  if (!client.__mbTypingSuppress) client.__mbTypingSuppress = new Map();
  const until = Date.now() + ms;
  client.__mbTypingSuppress.set(channelId, until);
  setTimeout(() => {
    const exp = client.__mbTypingSuppress.get(channelId);
    if (exp && exp <= Date.now()) client.__mbTypingSuppress.delete(channelId);
  }, ms + 500);
}

module.exports = { isTypingSuppressed, markTypingSuppressed };
