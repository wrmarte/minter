// commands/battle.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} = require('discord.js');

const { runRumbleDisplay } = require('../services/battleRumble');

const MAX_FIGHTERS = 2;

// ---------- helpers ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function progressBar(elapsed, total, width = 20) {
  const ratio = Math.max(0, Math.min(1, elapsed / total));
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function colorFor(style) {
  return style === 'villain' ? 0x8b0000
       : style === 'degen'   ? 0xe67e22
       : style === 'clean'   ? 0x3498db
       : 0x9b59b6; // motivator/default
}

function countdownEmbed({ title, subtitle, seconds, elapsed, color = 0x9b59b6 }) {
  const bar = progressBar(elapsed, seconds, 22);
  const remain = Math.max(0, seconds - elapsed);
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: 'Rumble Royale' })
    .setTitle(title)
    .setDescription([
      subtitle,
      '```',
      `[${bar}]  ${remain}s`,
      '```'
    ].join('\n'));
}

async function runTwoStageCountdown({
  message,          // Message to edit
  title,            // e.g. "⚔️ Battle Incoming: A vs B"
  style,            // for color
  stage1Seconds,    // 30 or 60
  stage2Seconds,    // 30 or 60
}) {
  const color = colorFor(style);

  // Stage 1: "Battle incoming"
  for (let t = 0; t <= stage1Seconds; t++) {
    const embed = countdownEmbed({
      title,
      subtitle: 'Spectators gathering…',
      seconds: stage1Seconds,
      elapsed: t,
      color
    });
    await message.edit({ embeds: [embed] }).catch(() => {});
    if (t < stage1Seconds) await sleep(1000);
  }

  // Stage 2: "Arena reveal"
  for (let t = 0; t <= stage2Seconds; t++) {
    const embed = countdownEmbed({
      title,
      subtitle: 'Arena reveal arming…',
      seconds: stage2Seconds,
      elapsed: t,
      color
    });
    await message.edit({ embeds: [embed] }).catch(() => {});
    if (t < stage2Seconds) await sleep(1000);
  }
}

function parseTimerChoice(choice) {
  // '30s' or '60s'
  if (choice === '60s') return 60;
  return 30; // default
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Owner-only: run a cinematic battle. Pick fighters or 1v1.')
    .addBooleanOption(opt =>
      opt.setName('manual_pick')
        .setDescription('Open a lobby to pick 2 fighters (you are auto-excluded).')
    )
    .addUserOption(opt =>
      opt.setName('opponent')
        .setDescription('1v1 mode: you vs this user (ignored if manual_pick=true).')
    )
    .addIntegerOption(opt =>
      opt.setName('bestof')
        .setDescription('Best of 1, 3, or 5.')
        .addChoices(
          { name: 'Best of 1', value: 1 },
          { name: 'Best of 3', value: 3 },
          { name: 'Best of 5', value: 5 },
        )
    )
    .addStringOption(opt =>
      opt.setName('style')
        .setDescription('Style (fallbacks to env default).')
        .addChoices(
          { name: 'clean', value: 'clean' },
          { name: 'motivator', value: 'motivator' },
          { name: 'villain', value: 'villain' },
          { name: 'degen', value: 'degen' },
        )
    )
    .addStringOption(opt =>
      opt.setName('incoming_timer')
        .setDescription('Countdown before intro (progress bar)')
        .addChoices(
          { name: '30 seconds', value: '30s' },
          { name: '1 minute',   value: '60s' },
        )
    )
    .addStringOption(opt =>
      opt.setName('arena_timer')
        .setDescription('Delay (progress bar) before arena reveal')
        .addChoices(
          { name: '30 seconds', value: '30s' },
          { name: '1 minute',   value: '60s' },
        )
    )
    .setDMPermission(false),

  async execute(interaction) {
    const OWNER_ID = (process.env.BOT_OWNER_ID || '').trim();
    if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: '⛔ Only the bot owner can use /battle right now.', ephemeral: true });
    }
    if (!interaction.guild || !interaction.channel) {
      return interaction.reply({ content: 'This command must be used in a server channel.', ephemeral: true });
    }

    const manualPick = interaction.options.getBoolean('manual_pick') || false;
    const bestOf     = interaction.options.getInteger('bestof') || 3;
    const style      = (interaction.options.getString('style') || process.env.BATTLE_STYLE_DEFAULT || 'motivator').toLowerCase();

    const incomingTimerSel = interaction.options.getString('incoming_timer') || '30s';
    const arenaTimerSel    = interaction.options.getString('arena_timer')    || '30s';
    const incomingSeconds  = parseTimerChoice(incomingTimerSel);
    const arenaSeconds     = parseTimerChoice(arenaTimerSel);

    // ===================== PATH A: EPHEMERAL LOBBY (owner adds 2) =====================
    if (manualPick) {
      const picked = new Set(); // user IDs (excluding owner)

      const render = () => {
        if (picked.size === 0) return 'Lobby: *(no fighters yet)*\n> Use the picker below to add fighters (2).';
        const list = [...picked].map(id => `<@${id}>`).join(', ');
        return `Lobby: **${picked.size}** picked → ${list}\n> Add more or press **Start**.`;
      };

      const selectRow = () => new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId('battle_lobby_select')
          .setPlaceholder('Pick ONE fighter to ADD (click again to add more)')
          .setMinValues(1)
          .setMaxValues(1) // single-pick; add repeatedly
      );

      const buttonsRow = (disabled = false) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('battle_lobby_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId('battle_lobby_clear').setLabel('Clear').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId('battle_lobby_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setDisabled(disabled),
      );

      await interaction.reply({
        content: render(),
        components: [selectRow(), buttonsRow()],
        ephemeral: true
      });
      const lobbyMsg = await interaction.fetchReply();

      const lobbyTimeoutMs = 5 * 60 * 1000;
      const lobbyEndsAt = Date.now() + lobbyTimeoutMs;

      const filter = (i) =>
        i.user.id === interaction.user.id &&
        (i.message.id === lobbyMsg.id) &&
        (i.customId === 'battle_lobby_select' ||
         i.customId === 'battle_lobby_start'  ||
         i.customId === 'battle_lobby_clear'  ||
         i.customId === 'battle_lobby_cancel');

      async function editLobby(content, disabled = false) {
        try {
          await interaction.editReply({ content, components: [selectRow(), buttonsRow(disabled)] });
        } catch {}
      }

      while (Date.now() < lobbyEndsAt) {
        let comp;
        try {
          const remaining = Math.max(1000, lobbyEndsAt - Date.now());
          comp = await lobbyMsg.awaitMessageComponent({ filter, time: remaining });
        } catch {
          await editLobby('⏱️ Lobby timed out.', true);
          return;
        }

        try {
          await comp.deferUpdate();

          if (comp.customId === 'battle_lobby_select' && comp.componentType === ComponentType.UserSelect) {
            const id = (comp.values && comp.values[0]) ? comp.values[0] : null;
            if (!id) { continue; }

            if (id === OWNER_ID) {
              await editLobby(`${render()}\n\n*You can’t add yourself; you’re excluded by design.*`);
              continue;
            }
            if (picked.has(id)) {
              await editLobby(`${render()}\n\n*(Already in lobby.)*`);
              continue;
            }
            if (picked.size >= MAX_FIGHTERS) {
              await editLobby(`${render()}\n\n*Max ${MAX_FIGHTERS} fighters reached.*`);
              continue;
            }
            picked.add(id);
            await editLobby(render());
            continue;
          }

          if (comp.customId === 'battle_lobby_clear') {
            picked.clear();
            await editLobby(render());
            continue;
          }

          if (comp.customId === 'battle_lobby_cancel') {
            await interaction.editReply({ content: 'Lobby cancelled.', components: [buttonsRow(true)] });
            return;
          }

          if (comp.customId === 'battle_lobby_start') {
            if (picked.size < 2) {
              await editLobby(`${render()}\n\n❌ Need at least **2** fighters.`);
              continue;
            }

            // Pick exactly two distinct fighters
            const ids = [...picked];
            const aIdx = Math.floor(Math.random() * ids.length);
            let bIdx = Math.floor(Math.random() * ids.length);
            while (bIdx === aIdx) bIdx = Math.floor(Math.random() * ids.length);

            const idA = ids[aIdx], idB = ids[bIdx];
            const guild = interaction.guild;

            await interaction.editReply({ content: `Starting: <@${idA}> vs <@${idB}>`, components: [buttonsRow(true)] });

            const [a, b] = await Promise.all([
              guild.members.fetch(idA).catch(() => null),
              guild.members.fetch(idB).catch(() => null),
            ]);

            if (!a || !b) {
              await interaction.editReply({ content: '❌ Could not resolve the selected fighters as guild members.', components: [selectRow(), buttonsRow()] });
              continue;
            }

            // Seed message (public), then two-stage countdown on it
            const title = `⚔️ Battle Incoming: ${a.displayName || a.user?.username} vs ${b.displayName || b.user?.username}`;
            const seed = await interaction.followUp({
              embeds: [new EmbedBuilder()
                .setColor(colorFor(style))
                .setAuthor({ name: 'Rumble Royale' })
                .setTitle(title)
                .setDescription('Preparing…')],
              fetchReply: true
            });

            await runTwoStageCountdown({
              message: seed,
              title,
              style,
              stage1Seconds: incomingSeconds,
              stage2Seconds: arenaSeconds
            });

            // Hand off to engine
            await runRumbleDisplay({
              channel: interaction.channel,
              baseMessage: seed,
              challenger: a,
              opponent: b,
              bestOf,
              style,
              guildName: interaction.guild.name
            });
            return; // done
          }
        } catch (err) {
          console.error('battle lobby component error:', err);
          try { await interaction.followUp({ content: 'Something went wrong handling that action.', ephemeral: true }); } catch {}
        }
      }

      await interaction.editReply({ content: '⏱️ Lobby timed out.', components: [buttonsRow(true)] });
      return;
    }

    // ===================== PATH B: CLASSIC 1v1 (you vs opponent) =====================
    const opponent = interaction.options.getUser('opponent');
    if (!opponent) {
      return interaction.reply({
        content: '❌ 1v1 mode: specify an opponent user, or set **manual_pick: true** to choose fighters.',
        ephemeral: true
      });
    }
    if (opponent.id === interaction.user.id) {
      return interaction.reply({ content: '❌ You can’t fight yourself. Choose someone else.', ephemeral: true });
    }

    const guild = interaction.guild;
    const me    = await guild.members.fetch(interaction.user.id).catch(() => null);
    const them  = await guild.members.fetch(opponent.id).catch(() => null);
    if (!me || !them) {
      return interaction.reply({ content: '❌ Could not resolve both fighters as guild members.', ephemeral: true });
    }

    // Seed message + two-stage countdown
    const title = `⚔️ Battle Incoming: ${me.displayName || me.user?.username} vs ${them.displayName || them.user?.username}`;
    const seed = await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(colorFor(style))
        .setAuthor({ name: 'Rumble Royale' })
        .setTitle(title)
        .setDescription('Preparing…')],
      fetchReply: true
    });

    await runTwoStageCountdown({
      message: seed,
      title,
      style,
      stage1Seconds: incomingSeconds,
      stage2Seconds: arenaSeconds
    });

    // Start the cinematic engine (it will overwrite the seed to intro, then reveal arena)
    await runRumbleDisplay({
      channel: interaction.channel,
      baseMessage: seed,
      challenger: me,
      opponent: them,
      bestOf,
      style,
      guildName: guild.name
    });
  },
};

