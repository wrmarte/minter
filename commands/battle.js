// commands/battle.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ComponentType,
  PermissionFlagsBits,
} = require('discord.js');

const { runRumbleDisplay } = require('../services/battleRumble');

// small helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pick2 = (arr) => {
  if (arr.length <= 2) return arr.slice(0, 2);
  const a = Math.floor(Math.random() * arr.length);
  let b = Math.floor(Math.random() * arr.length);
  while (b === a) b = Math.floor(Math.random() * arr.length);
  const first = arr[a];
  const second = arr[b];
  return [first, second];
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('battle')
    .setDescription('Run a cinematic 1v1 battle (owner-only). You can manually pick fighters.')
    .addBooleanOption(opt =>
      opt.setName('manual_pick')
        .setDescription('Open a user picker to select 2+ fighters (excludes you automatically).')
    )
    .addUserOption(opt =>
      opt.setName('opponent')
        .setDescription('1v1: fight this user (ignored if manual pick is used).')
    )
    .addIntegerOption(opt =>
      opt.setName('bestof')
        .setDescription('Rounds: Best of 1, 3, or 5.')
        .addChoices(
          { name: 'Best of 1', value: 1 },
          { name: 'Best of 3', value: 3 },
          { name: 'Best of 5', value: 5 },
        )
    )
    .addStringOption(opt =>
      opt.setName('style')
        .setDescription('Battle style (default from env).')
        .addChoices(
          { name: 'clean', value: 'clean' },
          { name: 'motivator', value: 'motivator' },
          { name: 'villain', value: 'villain' },
          { name: 'degen', value: 'degen' },
        )
    ),

  // NOTE: many repos pass (interaction, client); support both signatures safely
  async execute(interaction, maybeClient) {
    const client = interaction.client || maybeClient;

    // -------- Owner-only gate --------
    const OWNER_ID = (process.env.BOT_OWNER_ID || '').trim();
    if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
      try {
        return await interaction.reply({
          content: '⛔ Only the bot owner can use /battle right now.',
          ephemeral: true
        });
      } catch {}
      return;
    }

    // Basic sanity
    if (!interaction.guild || !interaction.channel) {
      return interaction.reply({ content: 'This command must be used in a server channel.', ephemeral: true });
    }

    const manualPick = interaction.options.getBoolean('manual_pick') || false;
    const bestOf     = interaction.options.getInteger('bestof') || 3;
    const style      = (interaction.options.getString('style') || process.env.BATTLE_STYLE_DEFAULT || 'motivator').toLowerCase();

    // ------------- Path A: Manual multi-pick (2+ fighters) -------------
    if (manualPick) {
      // Build a user select (min 2, max 12)
      const row = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId('battle_user_select')
          .setPlaceholder('Pick 2–12 fighters (you will be excluded).')
          .setMinValues(2)
          .setMaxValues(12)
      );

      // Ephemeral prompt for owner to pick users
      const prompt = await interaction.reply({
        content: 'Select **2–12** fighters. You will be excluded from the fight automatically.',
        components: [row],
        ephemeral: true
      });

      let pickedUsers = [];
      try {
        const select = await prompt.awaitMessageComponent({
          componentType: ComponentType.UserSelect,
          time: 60_000,
          filter: i => i.user.id === interaction.user.id && i.customId === 'battle_user_select'
        });

        const ids = select.values || [];
        // ack the selection quickly to avoid "interaction failed"
        await select.update({ content: `Picked ${ids.length} fighter(s). Starting…`, components: [] });

        // Fetch the members; filter out the owner/self if included
        const uniqIds = Array.from(new Set(ids.filter(id => id !== interaction.user.id)));
        if (uniqIds.length < 2) {
          return interaction.followUp({ content: '❌ Need at least **2** other users (excluding you).', ephemeral: true });
        }

        const guild = interaction.guild;
        const members = await guild.members.fetch({ user: uniqIds }).catch(() => null);
        if (!members) {
          return interaction.followUp({ content: '❌ Could not fetch members for those users.', ephemeral: true });
        }

        pickedUsers = uniqIds
          .map(id => members.get(id))
          .filter(Boolean);

        if (pickedUsers.length < 2) {
          return interaction.followUp({ content: '❌ Need at least **2 valid** users.', ephemeral: true });
        }

      } catch (e) {
        return interaction.followUp({ content: '⏱️ Selection timed out or was cancelled.', ephemeral: true });
      }

      // Choose any two from the selected list (for now, keep engine 1v1)
      const [p1, p2] = pick2(pickedUsers);
      if (!p1 || !p2) {
        return interaction.followUp({ content: '❌ Could not pick two fighters.', ephemeral: true });
      }

      // Post a public "incoming" seed message to reuse (lets service start a thread, etc.)
      const seed = await interaction.followUp({ content: `⚔️ Setting the stage for **${p1.displayName || p1.user?.username}** vs **${p2.displayName || p2.user?.username}**…`, fetchReply: true });
      // kick the engine
      await runRumbleDisplay({
        channel: interaction.channel,
        baseMessage: seed,
        challenger: p1,
        opponent: p2,
        bestOf,
        style,
        guildName: interaction.guild.name
      });
      return;
    }

    // ------------- Path B: Classic 1v1 (you vs opponent) -------------
    const opponent = interaction.options.getUser('opponent');
    if (!opponent) {
      return interaction.reply({
        content: '❌ 1v1 mode: please specify an opponent user, or set **manual_pick: true** to choose fighters.',
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

    // Public seed message, then hand off to display engine
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
