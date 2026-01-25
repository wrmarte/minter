// listeners/musclemb/suppression.js
// ======================================================
// Suppression helpers
// - Used to prevent MuscleMB from competing with MBella in a channel.
// ======================================================

function now() { return Date.now(); }

function ensure(client) {
  if (!client.__mbTypingSuppression) client.__mbTypingSuppression = new Map(); // channelId -> untilMs
  return client.__mbTypingSuppression;
}

function isTypingSuppressed(client, channelId) {
  try {
    if (!client || !channelId) return false;
    const map = ensure(client);
    const until = map.get(channelId) || 0;
    if (until <= now()) {
      map.delete(channelId);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function markTypingSuppressed(client, channelId, ms = 11000) {
  try {
    if (!client || !channelId) return false;
    const map = ensure(client);
    map.set(channelId, now() + Math.max(1000, Number(ms) || 11000));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  isTypingSuppressed,
  markTypingSuppressed,
};

