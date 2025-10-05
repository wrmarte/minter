// commands/rumble.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  PermissionFlagsBits,
} = require('discord.js');

const { runBracketRumble } = require('../services/rumbleBracket');
const { runRoyaleRumble }  = require('../services/rumbleRoyale');

const MAX_FIGHTERS = 12;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rumble')
    .setDescription('Owner-only: run a multi-fighter Rumble (Bracket or Battle Royale).')
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Rumble format')
        .setRequired(true)
        .addChoices(
          { name: 'Bracket (tournament)', value: 'bracket' },
          { name: 'Battle Royale (last standing)', value: 'royale' }
        )
    )
    .addIntegerOption(opt =>
      opt.setName('bestof')
        .setDescription('For 1v1 matches (Bracket): Best of 1, 3, or 5.')
        .addChoices(
          { name: 'Best of 1', value: 1 },
          { name: 'Best of 3', value: 3 },
          { name: 'Best of 5', value: 5 },
        )
    )
    .addStringOption(opt =>
      opt.setName('style')
        .setDescription('Style: clean | motivator | villain | degen (fallbacks to env default).')
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
      return interaction.reply({ content: '⛔ Only the bot owner can use /rumble right now.', ephemeral: true });
    }
    if (!interaction.guild || !interaction.channel) {
      return interaction.reply({ content: 'This command must be used in a server channel.', ephemeral: true });
    }

    const mode  = interaction.options.getString('mode');      // 'bracket' | 'royale'
    const bestOf = interaction.options.getInteger('bestof') || 3;
    const style  = (interaction.options.getString('style') || process.env.BATTLE_STYLE_DEFAULT || 'motivator').toLowerCase();

    // ====== EPHEMERAL PICKER LOBBY ======
    const picked = new Set(); // user IDs

    const render = () => {
      if (picked.size === 0) return 'Lobby: *(no fighters yet)*\n> Select 2–12 participants below.';
      const list = [...picked].map(id => `<@${id}>`).join(', ');
      return `Lobby: **${picked.size}** picked → ${list}\n> Add more or press **Start**.`;
    };

    const selectRow = () => new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('rumble_pick_users')
        .setPlaceholder('Pick fighters (select multiple at once)')
        .setMinValues(2)
        .setMaxValues(Math.min(MAX_FIGHTERS, 25))
    );

    const buttonsRow = (disabled = false) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rumble_start').setLabel('Start').setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId('rumble_clear').setLabel('Clear').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId('rumble_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    );

    await interaction.reply({
      content: render(),
      components: [selectRow(), buttonsRow()],
      ephemeral: true
    });

    const filter = (i) =>
      i.user.id === interaction.user.id &&
      ['rumble_pick_users', 'rumble_start', 'rumble_clear', 'rumble_cancel'].includes(i.customId);

    const lobbyTimeoutMs = 5 * 60 * 1000;
    const lobbyEndsAt = Date.now() + lobbyTimeoutMs;

    async function updateLobby(content, disabled = false) {
      try { await interaction.editReply({ content, components: [selectRow(), buttonsRow(disabled)] }); } catch {}
    }

    // loop on ephemeral component interactions
    while (Date.now() < lobbyEndsAt) {
      let comp;
      try {
        const remaining = Math.max(1000, lobbyEndsAt - Date.now());
        comp = await interaction.awaitMessageComponent({ filter, time: remaining });
      } catch {
        await updateLobby('⏱️ Lobby timed out.', true);
        return;
      }

      try {
        if (comp.customId === 'rumble_pick_users' && comp.componentType === ComponentType.UserSelect) {
          const ids = (comp.values || []).map(v => String(v));
          // Exclude owner (caller) and dedupe
          for (const id of ids) {
            if (id === OWNER_ID) continue;
            if (picked.size >= MAX_FIGHTERS) break;
            picked.add(id);
          }
          await comp.update({ content: render(), components: [selectRow(), buttonsRow()] });
          continue;
        }

        if (comp.customId === 'rumble_clear') {
          picked.clear();
          await comp.update({ content: render(), components: [selectRow(), buttonsRow()] });
          continue;
        }

        if (comp.customId === 'rumble_cancel') {
          await comp.update({ content: 'Lobby cancelled.', components: [buttonsRow(true)] });
          return;
        }

        if (comp.customId === 'rumble_start') {
          if (picked.size < 2) {
            await comp.update({ content: `${render()}\n\n❌ Need at least **2** fighters.`, components: [selectRow(), buttonsRow()] });
            continue;
          }
          // Resolve guild members
          const guild = interaction.guild;
          const ids = [...picked];
          const members = [];
          for (const id of ids) {
            const m = await guild.members.fetch(id).catch(() => null);
            if (m) members.push(m);
          }
          if (members.length < 2) {
            await comp.update({ content: '❌ Could not resolve enough fighters as guild members.', components: [selectRow(), buttonsRow()] });
            continue;
          }

          await comp.update({ content: `Starting **${mode}** with ${members.length} fighters…`, components: [buttonsRow(true)] });

          // Public seed message
          const names = members.map(m => m.displayName || m.user?.username).join(' vs ');
          const seedMsg = await interaction.followUp({
            content: `🎮 **${mode === 'bracket' ? 'Tournament Bracket' : 'Battle Royale'}** incoming…`,
            fetchReply: true
          });

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

          return;
        }
      } catch (err) {
        console.error('rumble lobby component error:', err);
        try { await comp.reply({ content: 'Something went wrong handling that action.', ephemeral: true }); } catch {}
      }
    }

    await updateLobby('⏱️ Lobby timed out.', true);
  },
};
