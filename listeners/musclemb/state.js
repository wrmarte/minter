// listeners/musclemb/state.js
module.exports = {
  cooldown: new Set(),

  lastActiveByUser: new Map(),     // `${guildId}:${userId}` -> { ts, channelId }
  lastNicePingByGuild: new Map(),  // guildId -> ts
  lastQuoteByGuild: new Map(),     // guildId -> { text, category, ts }

  sweepCooldownByUser: new Map(),       // `${guildId}:${userId}` -> ts
  adrianChartCooldownByUser: new Map(), // `${guildId}:${userId}` -> ts
};
