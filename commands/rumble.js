// commands/rumble.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  PermissionsBitField,
} = require('discord.js');

const MAX_FIGHTERS = 12;

// These should point to your multi-user services you already have wired up.
// - runBracketRumble: runs a bracket tournament with fighters[]
// - runRoyaleRumble:  runs a battle-royale (last standing) with fighters[]
const { runBracketRumble } = require('../services/rumbleBracket');
const { runRoyaleRumble }  = require('../services/rumbleRoyale');

// ---------- helpers ----------
function isOwner(interaction) {
  const OWNER_ID = (process.env.BOT_OWNER_ID || '').trim();
  return OWNER_ID && interaction.user.id === OWNER_ID;
}

function lobbyEmbed({ mode, style, bestOf, pickedIds, guildName, ownerMention }) {
  const title = mode === 'bracket' ? '🏟️ Rumble Lobby — Bracket' : '🏟️ Rumble Lobby — Battle Royale';
  const descTop = [
    `Host: ${ownerMention}`,
    `Mode: **${mode}**${mode === 'bracket' ? ` (Bo${bestOf})` : ''} • Style: **${style}**`,
    `Max fighters: **${MAX_FIGHTERS}**`,
    '',
    `Click **Join** to enter • **Leave** to exit`,
    `Host can pick fighters with the selector below.`,
  ].join('\n');

  const list = pickedIds.length
    ? pickedIds.map(id => `• <@${id}>`).join('\n')
    : '*No fighters yet — be the first to join!*';

  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setAuthor({ name: 'Rumble Royale' })
    .setTitle(title)
    .setDescription(descTop)
    .addFields(
      { name: `Fighters (${pickedIds.length}/${MAX_FIGHTERS})`, value: list.slice(0, 1024) || '—' },
    )
    .setFooter({ text: `${guildName} • Join now` });
}

function rows({ locked = false }) {
  // Public actions
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rumble_join').setLabel('Join').setStyle(ButtonStyle.Primary).setDisabled(locked),
    new ButtonBuilder().setCustomId('rumble_leave').setLabel('Leave').setStyle(ButtonStyle.Secondary).setDisabled(locked),
  );

  // Host actions
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rumble_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(locked),
    new ButtonBuilder().setCustomId('rumble_clear').setLabel('Clear').setStyle(ButtonStyle.Secondary).setDisabled(locked),
    new ButtonBuilder().setCustomId('rumble_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setDisabled(locked),
  );

  // Owner-only manual picker (kept visible; we gate by handler)
  const row3 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('rumble_select')
      .setPlaceholder('Host: pick fighters to add (multi-select OK)')
      .setMinValues(1)
      .setMaxValues(Math.min(25, MAX_FIGHTERS))
  );

  return [row1, row2, row3];
}

// Safely edit lobby (avoid throwing if message is gone)
async function safeEdit(msg, payload) {
  try { await msg.edit(payload); } catch {}
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rumble')
    .setDescription('Owner-only: open a lobby for a Bracket or Battle Royale.')
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Format')
        .setRequired(true)
        .addChoices(
          { name: 'Bracket (tournament)', value: 'bracket' },
          { name: 'Battle Royale (last standing)', value: 'royale' }
        )
    )
    .addIntegerOption(opt =>
      opt.setName('bestof')
        .setDescription('Best of (for Bracket). Default 3')
        .addChoices(
          { name: 'Best of 1', value: 1 },
          { name: 'Best of 3', value: 3 },
          { name: 'Best of 5', value: 5 },
        )
    )
    .addStringOption(opt =>
      opt.setName('style')
        .setDescription('clean | motivator | villain | degen (fallback = env default)')
        .addChoices(
          { name: 'clean', value: 'clean' },
          { name: 'motivator', value: 'motivator' },
          { name: 'villain', value: 'villain' },
          { name: 'degen', value: 'degen' },
        )
    ),

  async execute(interaction) {
    const OWNER_ID = (process.env.BOT_OWNER_ID || '').trim();

    if (!isOwner(interaction)) {
      return interaction.reply({ content: '⛔ Only the bot owner can use /rumble right now.', ephemeral: true });
    }
    if (!interaction.guild || !interaction.channel) {
      return interaction.reply({ content: 'This command must be used in a server channel.', ephemeral: true });
    }

    const mode   = interaction.options.getString('mode'); // 'bracket' | 'royale'
    const bestOf = interaction.options.getInteger('bestof') || 3;
    const style  = (interaction.options.getString('style') || process.env.BATTLE_STYLE_DEFAULT || 'motivator').toLowerCase();

    // Permissions sanity: need to send & manage messages where slash is used
    const mePerms = interaction.channel.permissionsFor(interaction.client.user);
    if (!mePerms?.has(PermissionsBitField.Flags.SendMessages)) {
      return interaction.reply({ content: '❌ I need permission to send messages in this channel.', ephemeral: true });
    }

    // Lobby state
    const picked = new Set(); // user IDs; excludes host
    const ownerMention = `<@${interaction.user.id}>`;

    const lobbyMessage = await interaction.reply({
      embeds: [lobbyEmbed({
        mode, style, bestOf,
        pickedIds: [...picked],
        guildName: interaction.guild.name,
        ownerMention
      })],
      components: rows({ locked: false }),
      fetchReply: true
    });

    // Collector on THIS message (public lobby)
    const collector = lobbyMessage.createMessageComponentCollector({ time: 5 * 60 * 1000 });

    const refresh = async () => {
      await safeEdit(lobbyMessage, {
        embeds: [lobbyEmbed({
          mode, style, bestOf,
          pickedIds: [...picked],
          guildName: interaction.guild.name,
          ownerMention
        })],
        components: rows({ locked: false })
      });
    };

    collector.on('collect', async (i) => {
      // Always gate unsafe actions quickly with an immediate reply/update
      const uid = i.user.id;

      // JOIN
      if (i.customId === 'rumble_join') {
        if (uid === OWNER_ID) {
          return i.reply({ content: 'You’re the host — you don’t join this one 😄', ephemeral: true });
        }
        if (picked.has(uid)) {
          return i.reply({ content: 'You’re already in the lobby.', ephemeral: true });
        }
        if (picked.size >= MAX_FIGHTERS) {
          return i.reply({ content: 'Lobby is full. Try again next match!', ephemeral: true });
        }
        if (i.user.bot) {
          return i.reply({ content: 'Bots can’t join.', ephemeral: true });
        }
        picked.add(uid);
        await i.deferUpdate();
        return refresh();
      }

      // LEAVE
      if (i.customId === 'rumble_leave') {
        if (!picked.has(uid)) {
          return i.reply({ content: 'You’re not in the lobby.', ephemeral: true });
        }
        picked.delete(uid);
        await i.deferUpdate();
        return refresh();
      }

      // OWNER-ONLY CONTROLS
      const ownerOnly = ['rumble_start', 'rumble_clear', 'rumble_cancel', 'rumble_select'];
      if (ownerOnly.includes(i.customId) && uid !== OWNER_ID) {
        return i.reply({ content: 'Only the host can do that.', ephemeral: true });
      }

      // OWNER: CLEAR
      if (i.customId === 'rumble_clear') {
        picked.clear();
        await i.deferUpdate();
        return refresh();
      }

      // OWNER: CANCEL
      if (i.customId === 'rumble_cancel') {
        collector.stop('cancelled');
        await i.update({
          embeds: [new EmbedBuilder(lobbyMessage.embeds[0].data)
            .setFooter({ text: `${interaction.guild.name} • Lobby cancelled` })
            .setColor(0x8b0000)],
          components: rows({ locked: true })
        });
        return;
      }

      // OWNER: MANUAL PICK (UserSelect)
      if (i.customId === 'rumble_select' && i.componentType === ComponentType.UserSelect) {
        // For UserSelect menus, use i.users (Collection) — not values
        const usersColl = i.users ?? null;
        const ids = usersColl ? [...usersColl.keys()] : [];
        let added = 0;

        for (const id of ids) {
          if (id === OWNER_ID) continue;
          if (picked.size >= MAX_FIGHTERS) break;
          // Avoid bots
          const usr = interaction.client.users.cache.get(id);
          if (usr?.bot) continue;
          picked.add(id);
          added++;
        }

        await i.update({
          embeds: [lobbyEmbed({
            mode, style, bestOf,
            pickedIds: [...picked],
            guildName: interaction.guild.name,
            ownerMention
          })],
          components: rows({ locked: false })
        });

        if (added === 0) {
          try { await i.followUp({ content: 'No eligible users were added (maybe full, or you picked bots/host).', ephemeral: true }); } catch {}
        }
        return;
      }

      // OWNER: START
      if (i.customId === 'rumble_start') {
        if (picked.size < 2) {
          return i.reply({ content: 'Need at least **2** fighters to start.', ephemeral: true });
        }

        // Lock UI & stop collector
        collector.stop('started');
        await i.update({
          embeds: [new EmbedBuilder(lobbyMessage.embeds[0].data)
            .setFooter({ text: `${interaction.guild.name} • Starting…` })
            .setColor(0x2ecc71)],
          components: rows({ locked: true })
        });

        // Resolve guild members
        const ids = [...picked].slice(0, MAX_FIGHTERS);
        const members = [];
        for (const id of ids) {
          const m = await interaction.guild.members.fetch(id).catch(() => null);
          if (m) members.push(m);
        }

        if (members.length < 2) {
          return i.followUp({ content: '❌ Could not resolve enough fighters as guild members after join.', ephemeral: true });
        }

        // Seed “incoming” message for services to reuse (prevents double-intro)
        const seedMsg = await interaction.followUp({
          content: `🎮 **${mode === 'bracket' ? 'Tournament Bracket' : 'Battle Royale'}** incoming…`,
          fetchReply: true
        });

        try {
          if (mode === 'bracket') {
            await runBracketRumble({
              channel: interaction.channel,
              baseMessage: seedMsg,
              fighters: members,
              bestOf,
              style,
              guildName: interaction.guild.name
            });
          } else {
            await runRoyaleRumble({
              channel: interaction.channel,
              baseMessage: seedMsg,
              fighters: members,
              style,
              guildName: interaction.guild.name
            });
          }
        } catch (err) {
          console.error('❌ Error starting rumble:', err);
          try {
            await interaction.followUp({ content: '❌ Something went wrong starting the rumble. Check logs.', ephemeral: true });
          } catch {}
        }
        return;
      }
    });

    collector.on('end', async (_c, reason) => {
      if (['cancelled', 'started'].includes(reason)) return;
      await safeEdit(lobbyMessage, {
        embeds: [new EmbedBuilder(lobbyMessage.embeds[0].data)
          .setFooter({ text: `${interaction.guild.name} • Lobby timed out` })
          .setColor(0xaaaaaa)],
        components: rows({ locked: true })
      });
    });
  },
};
