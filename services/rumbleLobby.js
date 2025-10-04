// services/rumbleLobby.js
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  UserSelectMenuBuilder, ComponentType, PermissionsBitField
} = require('discord.js');

function canSend(ch) {
  try {
    const me = ch?.guild?.members?.me;
    if (!me) return false;
    const perms = ch.permissionsFor(me);
    return perms?.has(PermissionsBitField.Flags.ViewChannel)
        && perms?.has(PermissionsBitField.Flags.SendMessages)
        && perms?.has(PermissionsBitField.Flags.EmbedLinks);
  } catch { return false; }
}
function findSpeakableChannel(guild, preferredId = null) {
  try {
    const ok = (c) => c?.isTextBased?.() && canSend(c);
    if (preferredId) {
      const ch = guild.channels.cache.get(preferredId);
      if (ok(ch)) return ch;
    }
    if (guild.systemChannel && ok(guild.systemChannel)) return guild.systemChannel;
    return guild.channels.cache.find(ok) || null;
  } catch { return null; }
}
function lobbyEmbed({ title, host, limit, seconds, players, postedIn }) {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(title)
    .setDescription(
      [
        `Host: **${host.displayName || host.user?.username}**`,
        `Slots: **${players.size} / ${limit}**`,
        `Time left: **${seconds}s**`,
        postedIn ? `Posting in: ${postedIn}` : '',
        '',
        (players.size
          ? Array.from(players.values()).map(p => `• ${p.displayName || p.user?.username}`).join('\n')
          : '_No players yet_'),
      ].filter(Boolean).join('\n')
    );
}
async function ack(i, payload = { content: 'OK', ephemeral: true }) {
  try {
    if (i.deferred || i.replied) return await i.followUp({ ...payload, ephemeral: true });
    return await i.reply({ ...payload, ephemeral: true });
  } catch { try { await i.deferUpdate(); } catch {} }
}

async function openLobby({
  channel, hostMember, title = '🔔 Rumble Lobby', limit = 8, joinSeconds = 30, notify
}) {
  const joinSet = new Map(); // userId -> GuildMember-ish
  joinSet.set(hostMember.id, hostMember);

  // choose where to post (optional forced channel)
  let target = channel;
  const forcedId = (process.env.RUMBLE_LOBBY_CHANNEL_ID || '').trim();
  if (forcedId) {
    const forced = channel.guild.channels.cache.get(forcedId);
    if (canSend(forced)) target = forced;
  }
  if (!canSend(target)) {
    const fallback = findSpeakableChannel(channel.guild, forcedId || channel.id);
    if (!fallback) {
      if (notify) await Promise.resolve(notify('I can’t post in any channel here — check my permissions.')).catch(()=>{});
      throw new Error('No speakable channel for lobby.');
    }
    target = fallback;
  }
  const moved = target.id !== channel.id;
  const postedIn = moved ? `<#${target.id}>` : null;
  if (moved && notify) {
    await Promise.resolve(notify(`I don’t have permission to post here. I opened the lobby in ${postedIn} instead.`)).catch(()=>{});
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rumble_join').setStyle(ButtonStyle.Success).setLabel('Join'),
    new ButtonBuilder().setCustomId('rumble_leave').setStyle(ButtonStyle.Secondary).setLabel('Leave'),
    new ButtonBuilder().setCustomId('rumble_start').setStyle(ButtonStyle.Primary).setLabel('Start'),
    new ButtonBuilder().setCustomId('rumble_cancel').setStyle(ButtonStyle.Danger).setLabel('Cancel')
  );
  const row2 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('rumble_add')
      .setPlaceholder('Host: invite fighters…')
      .setMinValues(1)
      .setMaxValues(Math.min(10, limit))
  );

  let seconds = joinSeconds;
  let msg = await target.send({
    embeds: [lobbyEmbed({ title, host: hostMember, limit, seconds, players: joinSet, postedIn })],
    components: [row1, row2],
  });

  const collector = msg.createMessageComponentCollector({ time: joinSeconds * 1000 });
  let ended = false;

  const tick = setInterval(async () => {
    if (ended) return;
    seconds = Math.max(0, seconds - 3);
    try {
      await msg.edit({
        embeds: [lobbyEmbed({ title, host: hostMember, limit, seconds, players: joinSet, postedIn })],
        components: [row1, row2]
      });
    } catch {}
  }, 3000);

  collector.on('collect', async (i) => {
    try {
      const isHost = i.user.id === hostMember.id;

      if (i.customId === 'rumble_join' && i.isButton()) {
        if (joinSet.size >= limit) return ack(i, { content: 'Lobby full.' });
        const mem = await i.guild.members.fetch(i.user.id).catch(() => null);
        if (!mem) return ack(i, { content: 'Could not add you.' });
        joinSet.set(i.user.id, mem);
        await ack(i, { content: 'Joined!' });

      } else if (i.customId === 'rumble_leave' && i.isButton()) {
        joinSet.delete(i.user.id);
        await ack(i, { content: 'Left.' });

      } else if (i.customId === 'rumble_start' && i.isButton()) {
        if (!isHost) return ack(i, { content: 'Only host can start.' });
        ended = true; collector.stop('host_start');
        await ack(i, { content: 'Starting!' });

      } else if (i.customId === 'rumble_cancel' && i.isButton()) {
        if (!isHost) return ack(i, { content: 'Only host can cancel.' });
        ended = true; collector.stop('host_cancel');
        await ack(i, { content: 'Canceled.' });

      } else if (i.customId === 'rumble_add' && i.componentType === ComponentType.UserSelect) {
        if (!isHost) return ack(i, { content: 'Only host can invite.' });
        const ids = i.values || [];
        const added = [];
        for (const id of ids) {
          if (joinSet.size >= limit) break;
          if (joinSet.has(id)) continue;
          let mem = await i.guild.members.fetch(id).catch(() => null);
          if (!mem) {
            const user = await i.client.users.fetch(id).catch(() => null);
            if (user) {
              mem = { id: user.id, user, displayName: user.username,
                displayAvatarURL: (...args) => user.displayAvatarURL(...args) };
            }
          }
          if (mem) {
            joinSet.set(id, mem);
            added.push(mem.displayName || mem.user?.username || id);
          }
        }
        await ack(i, { content: added.length ? `Invited: ${added.join(', ')}` : 'No new fighters added.' });
      }

      try {
        await msg.edit({
          embeds: [lobbyEmbed({ title, host: hostMember, limit, seconds, players: joinSet, postedIn })],
          components: [row1, row2]
        });
      } catch {}
    } catch { try { await i.deferUpdate(); } catch {} }
  });

  return await new Promise((resolve) => {
    collector.on('end', async (_collected, reason) => {
      clearInterval(tick);
      try { await msg.edit({ components: [] }); } catch {}
      const arr = Array.from(joinSet.values());
      if (reason === 'host_cancel') { try { await msg.edit({ content: '❌ Lobby canceled.', embeds: [] }); } catch {}; return resolve([]); }
      if (arr.length < 2) { try { await msg.edit({ content: '❌ Not enough players to start.', embeds: [] }); } catch {}; return resolve([]); }
      resolve(arr);
    });
  });
}

module.exports = { openLobby };
