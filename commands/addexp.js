const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addexp')
    .setDescription('Add a new expression (image or text)')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Unique name of the expression (e.g., "rich")')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of expression')
        .setRequired(true)
        .addChoices(
          { name: 'Image', value: 'image' },
          { name: 'Text', value: 'text' }
        )
    )
    .addStringOption(option =>
      option.setName('content')
        .setDescription('Image URL or message (e.g. "💸 {user} is rich!")')
        .setRequired(true)
    ),

  async execute(interaction, { pg }) {
    const ownerId = process.env.BOT_OWNER_ID;
    const isOwner = interaction.user.id === ownerId;

    const name = interaction.options.getString('name').toLowerCase();
    const type = interaction.options.getString('type');
    const content = interaction.options.getString('content');
    const guildId = isOwner ? null : interaction.guild?.id ?? null;

    try {
      await pg.query(
        `INSERT INTO expressions (name, type, content, guild_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name, guild_id)
         DO UPDATE SET type = EXCLUDED.type, content = EXCLUDED.content`,
        [name, type, content, guildId]
      );

      const scope = guildId ? 'this server' : 'globally';
      return interaction.reply(`✅ Expression \`${name}\` saved as \`${type}\` in ${scope}.`);
    } catch (err) {
      console.error('❌ Failed to insert expression:', err);
      return interaction.reply('⚠️ Error saving the expression.');
    }
  }
};


