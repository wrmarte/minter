// commands/battle.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const { runRumbleDisplay } = require('../services/battleRumble');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Owner-only: run a cinematic battle. Pick fighters or 1v1.')
    .addBooleanOption(opt =>
      opt.setName('manual_pick')
        .setDescription('Open a lobby to pick 2+ fighters (you are auto-excluded).')
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
    ),

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

    // =============== PATH A: LOBBY BUILDER (owner adds 2+ fighters) ===============
    if (manualPick) {
      const picked = new Set(); // store user IDs (excluding owner)
      const MAX = 12;
      const render = () => {
        if (picked.size === 0) return 'Lobby: *(no fighters yet)*\n> Use the picker below to add fighters (2–12).';
        const list = [...picked].map(id => `<@${id}>`).join(', ');
        return `Lobby: **${picked.size}** picked → ${list}\n> Add more or press **Start**.`;
      };

      const selectRow = () => new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId('battle_lobby_select')
          .setPlaceholder('Pick a fighter to ADD (repeat to add more)')
          .setMinValues(1)
          .setMaxValues(1) // single-pick; we add on each selection
      );

      const buttonsRow = (disabled = false) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('battle_lobby_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId('battle_lobby_clear').setLabel('Clear').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId('battle_lobby_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setDisabled(disabled),
      );

      const msg = await interaction.reply({
        content: render(),
        components: [selectRow(), buttonsRow()],
        ephemeral: true
      });

      const collector = msg.createMessageComponentCollector({
        time: 5 * 60 * 1000, // 5 min
        filter: i => i.user.id === interaction.user.id && i.message.id === msg.id
      });

      collector.on('collect', async (i) => {
        try {
          if (i.customId === 'battle_lobby_select' && i.componentType === ComponentType.UserSelect) {
            const id = (i.values && i.values[0]) ? i.values[0] : null;
            if (!id) return i.deferUpdate();

            if (id === OWNER_ID) {
              return i.update({ content: `${render()}\n\n*You can’t add yourself; you’re excluded by design.*`, components: [selectRow(), buttonsRow()] });
            }
            if (picked.has(id)) {
              return i.update({ content: `${render()}\n\n*(Already in lobby.)*`, components: [selectRow(), buttonsRow()] });
            }
            if (picked.size >= MAX) {
              return i.update({ content: `${render()}\n\n*Max ${MAX} fighters reached.*`, components: [selectRow(), buttonsRow()] });
            }
            picked.add(id);
            return i.update({ content: render(), components: [selectRow(), buttonsRow()] });
          }

          if (i.customId === 'battle_lobby_clear') {
            picked.clear();
            return i.update({ content: render(), components: [selectRow(), buttonsRow()] });
          }

          if (i.customId === 'battle_lobby_cancel') {
            collector.stop('cancel');
            return i.update({ content: 'Lobby cancelled.', components: [buttonsRow(true)] });
          }

          if (i.customId === 'battle_lobby_start') {
            if (picked.size < 2) {
              return i.update({ content: `${render()}\n\n❌ Need at least **2** fighters.`, components: [selectRow(), buttonsRow()] });
            }
            // Resolve members and start a **single 1v1** for now (engine is 1v1)
            const ids = [...picked];
            // Choose any two distinct fighters
            const aIdx = Math.floor(Math.random() * ids.length);
            let bIdx = Math.floor(Math.random() * ids.length);
            while (bIdx === aIdx) bIdx = Math.floor(Math.random() * ids.length);

            const idA = ids[aIdx], idB = ids[bIdx];
            const guild = interaction.guild;
            const [a, b] = await Promise.all([
              guild.members.fetch(idA).catch(() => null),
              guild.members.fetch(idB).catch(() => null),
            ]);

            if (!a || !b) {
              return i.update({ content: '❌ Could not resolve the selected fighters as guild members.', components: [selectRow(), buttonsRow()] });
            }

            // Post a public seed message, then start the battle
            const seed = await interaction.followUp({
              content: `⚔️ Battle incoming: **${a.displayName || a.user?.username}** vs **${b.displayName || b.user?.username}**…`,
              fetchReply: true
            });

            // Disable lobby UI and finish
            await i.update({ content: `Starting: <@${idA}> vs <@${idB}>`, components: [buttonsRow(true)] });
            collector.stop('start');

            await runRumbleDisplay({
              channel: interaction.channel,
              baseMessage: seed,
              challenger: a,
              opponent: b,
              bestOf,
              style,
              guildName: interaction.guild.name
            });
          }
        } catch (err) {
          console.error('battle lobby error:', err);
          try { await i.reply({ content: 'Something went wrong handling that action.', ephemeral: true }); } catch {}
        }
      });

      collector.on('end', async (_collected, reason) => {
        if (reason === 'start' || reason === 'cancel') return;
        try { await msg.edit({ content: '⏱️ Lobby timed out.', components: [buttonsRow(true)] }); } catch {}
      });

      return;
    }

    // =============== PATH B: CLASSIC 1v1 (you vs opponent) ===============
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

    const seed = await interaction.reply({
      content: `⚔️ Battle incoming: **${me.displayName || me.user?.username}** vs **${them.displayName || them.user?.username}**…`,
      fetchReply: true
    });

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

