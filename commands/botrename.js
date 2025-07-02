const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('botrename')
    .setDescription('Rename the bot for this server (admin or bot owner only)')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('New bot nickname')
        .setRequired(true)
    ),

  async execute(interaction) {
    const newName = interaction.options.getString('name');
    const userId = interaction.user.id;
    const guild = interaction.guild;
    const member = guild.members.me;

    // Check permissions
    const isBotOwner = userId === process.env.BOT_OWNER_ID;
    const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

    if (!isBotOwner && !isAdmin) {
      return interaction.reply({ content: '❌ Only server admins or the bot owner can use this command.', ephemeral: true });
    }

    if (!guild || !member) {
      return interaction.reply({ content: '⚠️ Could not access server context or bot member.', ephemeral: true });
    }

    try {
      await member.setNickname(newName);
      await interaction.reply({ content: `✅ Bot nickname updated to **${newName}** in this server.`, ephemeral: false });
    } catch (err) {
      console.error('❌ Failed to change bot nickname:', err);
      await interaction.reply({ content: '⚠️ Failed to change nickname. Make sure I have the **Change Nickname** permission.', ephemeral: true });
    }
  }
};
