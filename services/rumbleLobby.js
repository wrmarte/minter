// services/rumbleLobby.js
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

function lobbyEmbed({ title, host, limit, seconds, players }) {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(title)
    .setDescription(
      [
        `Host: **${host.displayName || host.user?.username}**`,
        `Slots: **${players.size} / ${limit}**`,
        `Time left: **${seconds}s**`,
        '',
        (players.size ? Array.from(players.values()).map(p => `• ${p.displayName || p.user?.username}`).join('\n') : '_No players yet_')
      ].join('\n')
    );
}

async function openLobby({
  channel,
  hostMember,             // GuildMember
  title = '🔔 Rumble Lobby',
  limit = 8,
  joinSeconds = 30
}) {
  const joinSet = new Map(); // userId -> GuildMember
  joinSet.set(hostMember.id, hostMember); // host auto-joined

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rumble_join').setStyle(ButtonStyle.Success).setLabel('Join'),
    new ButtonBuilder().setCustomId('rumble_leave').setStyle(ButtonStyle.Secondary).setLabel('Leave'),
    new ButtonBuilder().setCustomId('rumble_start').setStyle(ButtonStyle.Primary).setLabel('Start Now'),
    new ButtonBuilder().setCustomId('rumble_cancel').setStyle(ButtonStyle.Danger).setLabel('Cancel')
  );

  let seconds = joinSeconds;
  let msg = await channel.send({ embeds: [lobbyEmbed({ title, host: hostMember, limit, seconds, players: joinSet })], components: [row] });

  const collector = msg.createMessageComponentCollector({ time: joinSeconds * 1000 });
  let ended = false;

  const tick = setInterval(async () => {
    if (ended) return;
    seconds -= 3;
    if (seconds < 0) seconds = 0;
    try {
      await msg.edit({ embeds: [lobbyEmbed({ title, host: hostMember, limit, seconds, players: joinSet })], components: [row] });
    } catch {}
  }, 3000);

  collector.on('collect', async (i) => {
    try {
      // only host can start/cancel
      const isHost = i.user.id === hostMember.id;
      if (i.customId === 'rumble_join') {
        if (joinSet.size >= limit) return i.reply({ content: 'Lobby full.', ephemeral: true });
        const mem = await i.guild.members.fetch(i.user.id).catch(() => null);
        if (!mem) return i.reply({ content: 'Could not add you.', ephemeral: true });
        joinSet.set(i.user.id, mem);
        await i.reply({ content: 'Joined!', ephemeral: true });
      } else if (i.customId === 'rumble_leave') {
        joinSet.delete(i.user.id);
        await i.reply({ content: 'Left.', ephemeral: true });
      } else if (i.customId === 'rumble_start') {
        if (!isHost) return i.reply({ content: 'Only host can start.', ephemeral: true });
        ended = true; collector.stop('host_start');
        await i.reply({ content: 'Starting!', ephemeral: true });
      } else if (i.customId === 'rumble_cancel') {
        if (!isHost) return i.reply({ content: 'Only host can cancel.', ephemeral: true });
        ended = true; collector.stop('host_cancel');
        await i.reply({ content: 'Canceled.', ephemeral: true });
      }
      // live refresh
      try { await msg.edit({ embeds: [lobbyEmbed({ title, host: hostMember, limit, seconds, players: joinSet })], components: [row] }); } catch {}
    } catch {}
  });

  return await new Promise((resolve) => {
    collector.on('end', async (_collected, reason) => {
      clearInterval(tick);
      let arr = Array.from(joinSet.values());
      if (reason === 'host_cancel') {
        try { await msg.edit({ content: '❌ Lobby canceled.', embeds: [], components: [] }); } catch {}
        return resolve([]);
      }
      if (arr.length < 2) {
        try { await msg.edit({ content: '❌ Not enough players to start.', embeds: [], components: [] }); } catch {}
        return resolve([]);
      }
      // lock UI
      try { await msg.edit({ embeds: [lobbyEmbed({ title, host: hostMember, limit, seconds: 0, players: joinSet })], components: [] }); } catch {}
      resolve(arr);
    });
  });
}

module.exports = { openLobby };
