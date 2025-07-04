const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('settheme')
    .setDescription('Set your server\'s FlexCard theme colors (Premium only)')
    .addStringOption(opt =>
      opt.setName('bg_color')
        .setDescription('Background HEX color (e.g., #123456)')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('accent_color')
        .setDescription('Accent HEX color (e.g., #abcdef)')
        .setRequired(true)
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild?.id;
    const isBotOwner = userId === process.env.BOT_OWNER_ID;
    const isAdmin = interaction.member?.permissions?.has('Administrator');

    if (!guildId) {
      return interaction.reply({ content: '❌ This command can only be used inside a server.', ephemeral: true });
    }

    if (!isBotOwner && !isAdmin) {
      return interaction.reply({ content: '❌ Only server admins or the bot owner can set the theme.', ephemeral: true });
    }

    // ✅ Premium Tier Check
    const res = await interaction.client.pg.query(
      'SELECT tier FROM premium_servers WHERE server_id = $1',
      [guildId]
    );
    const tier = res.rows[0]?.tier || 'free';
    if (tier === 'free') {
      return interaction.reply({
        content: '🔒 This command requires **Premium** or **PremiumPlus** tier.',
        ephemeral: true
      });
    }

    const bg = interaction.options.getString('bg_color');
    const accent = interaction.options.getString('accent_color');

    const isHex = hex => /^#[0-9A-F]{6}$/i.test(hex);
    if (!isHex(bg) || !isHex(accent)) {
      return interaction.reply({
        content: '⚠️ Please use valid hex codes like `#ffcc00` or `#123456`.',
        ephemeral: true
      });
    }

    try {
      await interaction.client.pg.query(`
        INSERT INTO theme_settings (guild_id, bg_color, accent_color)
        VALUES ($1, $2, $3)
        ON CONFLICT (guild_id) DO UPDATE
        SET bg_color = EXCLUDED.bg_color,
            accent_color = EXCLUDED.accent_color
      `, [guildId, bg, accent]);

      await interaction.reply({
        content: `🎨 Theme updated!\nBackground: \`${bg}\`\nAccent: \`${accent}\``,
        ephemeral: true
      });
    } catch (err) {
      console.error('❌ Error in /settheme:', err);
      await interaction.reply({ content: '⚠️ Failed to update theme.', ephemeral: true });
    }
  }
};
