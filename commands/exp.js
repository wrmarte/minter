const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('exp')
    .setDescription('Show a visual experience vibe')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Name of the expression (e.g. "rich")')
        .setRequired(true)
    ),

  async execute(interaction, { pg }) {
    const ownerId = process.env.BOT_OWNER_ID;
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: '❌ Only the bot owner can use this command.', flags: 64 });
    }

    const name = interaction.options.getString('name').toLowerCase();
    const guildId = interaction.guild?.id ?? null;

    // Try to find server-specific first, then global fallback
    const res = await pg.query(`
      SELECT * FROM expressions
      WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL)
      ORDER BY guild_id DESC
      LIMIT 1
    `, [name, guildId]);

    if (!res.rows.length) {
      return interaction.reply({ content: `❌ No expression named \`${name}\` found.`, flags: 64 });
    }

    const exp = res.rows[0];
    const userMention = `<@${interaction.user.id}>`;
    const message = exp.content.includes('{user}')
      ? exp.content.replace('{user}', userMention)
      : `${userMention} ${exp.content}`;

    // 🖼️ If image
    if (exp.type === 'image') {
      try {
        const file = new AttachmentBuilder(exp.content);
        return await interaction.reply({ content: message, files: [file] });
      } catch (err) {
        console.error('❌ Error loading image:', err);
        return await interaction.reply({ content: `⚠️ Couldn't load the image.`, flags: 64 });
      }
    }

    // 📝 If text
    return interaction.reply({ content: message });
  }
};

