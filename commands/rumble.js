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

const { runBracketRumble } = require('../services/rumbleBracket');
const { runRoyaleRumble }  = require('../services/rumbleRoyale');

// ---------- helpers ----------
function isOwner(interaction) {
  const OWNER_ID = (process.env.BOT_OWNER_ID || '').trim();
  return OWNER_ID && interaction.user.id === OWNER_ID;
}

function lobbyEmbed({ mode, style, pickedIds, guildName, ownerMention }) {
  const title = mode === 'bracket' ? '🏟️ Rumble Lobby — Bracket' : '🏟️ Rumble Lobby — Battle Royale';
  const descTop = [
    `Host: ${ownerMention}`,
    `Mode: **${mode}**${mode === 'bracket' ? ` (Bo1)` : ''} • Style: **${style}**`,
    `Max fighters: **${MAX_FIGHTERS}**`,
    '',
    `Click **Join** to enter • **Leave** to exit`,
    `Host may also **Join** and can add fighters with the selector.`,
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

  // Owner manual picker (anyone sees it; only host can use)
  const row3 = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('rumble_select')
      .setPlaceholder('Host: pick fighters to add (multi-select OK)')
      .setMinValues(1)
      .setMaxValues(Math.min(25, MAX_FIGHTERS))
  );

  return [row1, row2, row3];
}

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
    if (!isOwner(interaction)) {
      return interaction.reply({ content: '⛔ Only the bot owner can use /rumble right now.', ephemeral: true });
    }
    if (!interaction.guild || !interaction.channel) {
      return interaction.reply({ content: 'This command must be used in a server channel.', ephemeral: true });
    }

    const mode   = interaction.options.getString('mode'); // 'bracket' | 'royale'
    const style  = (interaction.options.getString('style') || process.env.BATTLE_STYLE_DEFAULT || 'motivator').toLowerCase();

    // Always Bo1 per your spec (hide from command UI)
    const bestOf = 1;

    const mePerms = interaction.channel.permissionsFor(interaction.client.user);
    if (!mePerms?.has(PermissionsBitField.Flags.SendMessages)) {
      return interaction.reply({ content: '❌ I need permission to send messages in this channel.', ephemeral: true });
    }

    // Lobby state
    const picked = new Set(); // includes host if they press Join
    const ownerMention = `<@${interaction.user.id}>`;

    const lobbyMessage = await interaction.reply({
      embeds: [lobbyEmbed({
        mode, style,
        pickedIds: [...picked],
        guildName: interaction.guild.name,
        ownerMention
      })],
      components: rows({ locked: false }),
      fetchReply: true
    });

    const collector = lobbyMessage.createMessageComponentCollector({ time: 5 * 60 * 1000 });

    const refresh = async () => {
      await safeEdit(lobbyMessage, {
        embeds: [lobbyEmbed({
          mode, style,
          pickedIds: [...picked],
          guildName: interaction.guild.name,
          ownerMention
        })],
        components: rows({ locked: false })
      });
    };

    collector.on('collect', async (i) => {
      const uid = i.user.id;
      const OWNER_ID = (process.env.BOT_OWNER_ID || '').trim();

      // JOIN (host allowed)
      if (i.customId === 'rumble_join') {
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
        try { await i.deferUpdate(); } catch {}
        return refresh();
      }

      // LEAVE
      if (i.customId === 'rumble_leave') {
        if (!picked.has(uid)) {
          return i.reply({ content: 'You’re not in the lobby.', ephemeral: true });
        }
        picked.delete(uid);
        try { await i.deferUpdate(); } catch {}
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
        try { await i.deferUpdate(); } catch {}
        return refresh();
      }

      // OWNER: CANCEL
      if (i.customId === 'rumble_cancel') {
        collector.stop('cancelled');
        const clone = EmbedBuilder.from(lobbyMessage.embeds[0]);
        await i.update({
          embeds: [clone.setFooter({ text: `${interaction.guild.name} • Lobby cancelled` }).setColor(0x8b0000)],
          components: rows({ locked: true })
        });
        return;
      }

      // OWNER: MANUAL PICK (UserSelect) — robust: use i.values + deferUpdate
      if (i.customId === 'rumble_select' && i.componentType === ComponentType.UserSelect) {
        const values = Array.isArray(i.values) ? i.values : [];
        let added = 0;

        for (const id of values) {
          if (picked.size >= MAX_FIGHTERS) break;
          const usr = interaction.client.users.cache.get(id);
          if (usr?.bot) continue;
          picked.add(id);
          added++;
        }

        try { await i.deferUpdate(); } catch {}
        await refresh();

        if (added === 0) {
          try { await interaction.followUp({ content: 'No eligible users were added (maybe full, or you picked bots).', ephemeral: true }); } catch {}
        }
        return;
      }

      // OWNER: START
      if (i.customId === 'rumble_start') {
        if (picked.size < 2) {
          return i.reply({ content: 'Need at least **2** fighters to start.', ephemeral: true });
        }

        collector.stop('started');
        const clone = EmbedBuilder.from(lobbyMessage.embeds[0]);
        await i.update({
          embeds: [clone.setFooter({ text: `${interaction.guild.name} • Starting…` }).setColor(0x2ecc71)],
          components: rows({ locked: true })
        });

        // Resolve members
        const ids = [...picked].slice(0, MAX_FIGHTERS);
        const members = [];
        for (const id of ids) {
          const m = await interaction.guild.members.fetch(id).catch(() => null);
          if (m) members.push(m);
        }
        if (members.length < 2) {
          return interaction.followUp({ content: '❌ Could not resolve enough fighters as guild members after join.', ephemeral: true });
        }

        const seedMsg = await interaction.followUp({
          content: `🎮 **${mode === 'bracket' ? 'Tournament Bracket (Bo1)' : 'Battle Royale'}** incoming…`,
          fetchReply: true
        });

        try {
          if (mode === 'bracket') {
            await runBracketRumble({
              channel: interaction.channel,
              baseMessage: seedMsg,
              fighters: members,
              bestOf, // = 1
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
      const clone = EmbedBuilder.from(lobbyMessage.embeds[0]);
      await safeEdit(lobbyMessage, {
        embeds: [clone.setFooter({ text: `${interaction.guild.name} • Lobby timed out` }).setColor(0xaaaaaa)],
        components: rows({ locked: true })
      });
    });
  },
};

