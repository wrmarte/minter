const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const BOT_OWNER_ID = process.env.BOT_OWNER_ID;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dummyedit')
    .setDescription('Edit the content of an existing dummy info block')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Name of the dummy info to edit')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('newcontent')
        .setDescription('New content for the dummy info')
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
    const newContent = interaction.options.getString('newcontent');
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    try {
      const result = await pg.query(
        'UPDATE dummy_info SET content = $1 WHERE name = $2 AND guild_id = $3 RETURNING *',
        [newContent, name, guildId]
      );

      if (result.rowCount === 0) {
        return await interaction.reply({ content: `❌ No dummy info named "${name}" exists.`, ephemeral: true });
      }

      await interaction.reply({ content: `✏️ Updated dummy info "${name}".`, ephemeral: true });
    } catch (err) {
      console.error('❌ Failed to update dummy info:', err);
      await interaction.reply({ content: '❌ Failed to update dummy info.', ephemeral: true });
    }
  },

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const pg = interaction.client.pg;
    const guildId = interaction.guild.id;

    try {
      const res = await pg.query(
        'SELECT name FROM dummy_info WHERE guild_id = $1',
        [guildId]
      );

      const choices = res.rows
        .map(r => r.name)
        .filter(name => name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25);

      await interaction.respond(
        choices.map(name => ({ name, value: name }))
      );
    } catch (err) {
      console.error('❌ dummyedit autocomplete error:', err);
      await interaction.respond([]);
    }
  }
};

