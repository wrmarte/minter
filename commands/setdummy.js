const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const BOT_OWNER_ID = process.env.BOT_OWNER_ID;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setdummy')
    .setDescription('Save or update a dummy info block for this server')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Name of the dummy info (e.g. welcome, faq)')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('content')
        .setDescription('The full content for the embed body')
        .setRequired(true)
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const isOwner = userId === BOT_OWNER_ID;

    if (!isAdmin && !isOwner) {
      return await interaction.reply({
        content: '❌ You must be a server admin or bot owner to use this command.',
        ephemeral: true
      });
    }

    const name = interaction.options.getString('name');
    const content = interaction.options.getString('content');
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    try {
      await pg.query(`
        INSERT INTO dummy_info (name, content, guild_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (name, guild_id)
        DO UPDATE SET content = $2
      `, [name, content, guildId]);

      await interaction.reply({
        content: `✅ Saved dummy info "${name}" for this server.`,
        ephemeral: true
      });
    } catch (err) {
      console.error('❌ Failed to save dummy info:', err);
      await interaction.reply({ content: '❌ Failed to save dummy info.', ephemeral: true });
    }
  }
};
