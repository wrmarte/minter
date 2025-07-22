const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const BOT_OWNER_ID = process.env.BOT_OWNER_ID;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dummydel')
    .setDescription('Delete a saved dummy info block')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Name of the dummy info to delete')
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
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    try {
      const result = await pg.query(
        'DELETE FROM dummy_info WHERE name = $1 AND guild_id = $2 RETURNING *',
        [name, guildId]
      );

      if (result.rowCount === 0) {
        return await interaction.reply({ content: `❌ No dummy info named "${name}" was found.`, ephemeral: true });
      }

      await interaction.reply({ content: `🗑️ Deleted dummy info "${name}".`, ephemeral: true });
    } catch (err) {
      console.error('❌ Failed to delete dummy info:', err);
      await interaction.reply({ content: '❌ Failed to delete dummy info.', ephemeral: true });
    }
  }
};
