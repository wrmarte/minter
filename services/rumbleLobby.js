// services/rumbleLobby.js
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, UserSelectMenuBuilder, ComponentType, PermissionsBitField
} = require('discord.js');

/* ========= utils ========= */
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
    const me = guild?.members?.me;
    if (!me) return null;
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
          : '_No players yet_')
      ].filter(Boolean).join('\n')
    );
}

/**
 * Open a lobby with Join/Leave/Start/Cancel buttons + HOST-ONLY UserSelect to add people.
 * If we lack permission in the current channel, we’ll pick a fallback channel the bot CAN speak in.
 *
 * @param {Object} opts
 * @param {TextChannel|ThreadChannel} opts.channel
 * @param {GuildMember} opts.hostMember
 * @param {string} [opts.title]
 * @param {number} [opts.limit]
 * @param {number} [opts.joinSeconds]
 * @param {(msg: string)=>Promise<void>} [opts.notify] optional callback to notify host ephemerally
 */
async function openLobby({
  channel,
  hostMember,
  title = '🔔 Rumble Lobby',
  limit = 8,
  joinSeconds = 30,
  notify
}) {
  const joinSet = new Map(); // userId -> GuildMember
  joinSet.set(hostMember.id, hostMember); // host auto-join

  // choose where to post
  let postCh = canSend(channel) ? channel : findSpeakableChannel(channel.guild, channel.id);
  const moved = postCh?.id !== channel?.id;

  if (moved && notify) {
    await Promise.resolve(notify(`I don’t have permission to post here. I opened the lobby in <#${postCh.id}> instead.`)).catch(()=>{});
  }

  const postedIn = moved ? `<#${postCh.id}>` : null;

  // components
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rumble_join').setStyle(ButtonStyle.Success).setLabel('Join'),
    new ButtonBuilder().setCustomId('rumble_leave').setStyle(ButtonStyle.Secondary).setLabel('Leave'),
    new ButtonBuilder().setCustomId('rumble_start').setStyle(ButtonStyle.Primary).setLabel('Start'),
    new ButtonBuilder().setCustomId('rumble_cancel').setStyle(ButtonStyle.Danger).setLabel('Cancel')
  );

  // host-only user selector to add multiple fighters
  const row2 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('rumble_add')
      .setPlaceholder('Host: invite fighters…')
      .setMinValues(1)
      .setMaxValues(Math.min(10, limit))
  );

  // post lobby
  let seconds = joinSeconds;
  let msg = await postCh.send({
    embeds: [lobbyEmbed({ title, host: hostMember, limit, seconds, players: joinSet, postedIn })],
    components: [row1, row2],
  });

  // collector
  const collector = msg.createMessageComponentCollector({
    time: joinSeconds * 1000,
    componentType: ComponentType.ActionRow // collects both buttons & selects
  });
  let ended = false;

  // timer tick (UI refresh)
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
        if (joinSet.size >= limit) return i.reply({ content: 'Lobby full.', ephemeral: true });
        const mem = await i.guild.members.fetch(i.user.id).catch(() => null);
        if (!mem) return i.reply({ content: 'Could not add you.', ephemeral: true });
        joinSet.set(i.user.id, mem);
        await i.reply({ content: 'Joined!', ephemeral: true });

      } else if (i.customId === 'rumble_leave' && i.isButton()) {
        joinSet.delete(i.user.id);
        await i.reply({ content: 'Left.', ephemeral: true });

      } else if (i.customId === 'rumble_start' && i.isButton()) {
        if (!isHost) return i.reply({ content: 'Only host can start.', ephemeral: true });
        ended = true; collector.stop('host_start');
        await i.reply({ content: 'Starting!', ephemeral: true });

      } else if (i.customId === 'rumble_cancel' && i.isButton()) {
        if (!isHost) return i.reply({ content: 'Only host can cancel.', ephemeral: true });
        ended = true; collector.stop('host_cancel');
        await i.reply({ content: 'Canceled.', ephemeral: true });

      } else if (i.customId === 'rumble_add' && i.isUserSelectMenu()) {
        if (!isHost) return i.reply({ content: 'Only host can invite.', ephemeral: true });
        const ids = i.values || [];
        const added = [];
        for (const id of ids) {
          if (joinSet.size >= limit) break;
          if (joinSet.has(id)) continue;
          const mem = await i.guild.members.fetch(id).catch(() => null);
          if (mem) { joinSet.set(id, mem); added.push(mem.displayName || mem.user?.username || id); }
        }
        await i.reply({ content: added.length ? `Invited: ${added.join(', ')}` : 'No new fighters added.', ephemeral: true });
      }

      // live update
      try {
        await msg.edit({
          embeds: [lobbyEmbed({ title, host: hostMember, limit, seconds, players: joinSet, postedIn })],
          components: [row1, row2]
        });
      } catch {}
    } catch {}
  });

  return await new Promise((resolve) => {
    collector.on('end', async (_collected, reason) => {
      clearInterval(tick);
      const arr = Array.from(joinSet.values());

      // lock UI
      try { await msg.edit({ components: [] }); } catch {}

      if (reason === 'host_cancel') {
        try { await msg.edit({ content: '❌ Lobby canceled.', embeds: [] }); } catch {}
        return resolve([]);
      }
      if (arr.length < 2) {
        try { await msg.edit({ content: '❌ Not enough players to start.', embeds: [] }); } catch {}
        return resolve([]);
      }
      resolve(arr);
    });
  });
}

module.exports = { openLobby };

