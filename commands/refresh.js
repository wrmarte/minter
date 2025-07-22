const { SlashCommandBuilder } = require('discord.js');
const { REST, Routes } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('🔄 Force refresh slash commands (owner only)'),

  async execute(interaction) {
    // ✅ Check owner only
    if (interaction.user.id !== process.env.BOT_OWNER_ID) {
      return interaction.reply({ content: '🚫 You are not authorized to run this command.', ephemeral: true });
    }

    const client = interaction.client;
    const token = process.env.DISCORD_BOT_TOKEN;
    const clientId = process.env.CLIENT_ID;
    const guildId = process.env.TEST_GUILD_ID || null;

    const rest = new REST({ version: '10' }).setToken(token);
    const commands = client.commands.map(cmd => cmd.data.toJSON());

    try {
      await interaction.reply({ content: '⏳ Refreshing slash commands...', ephemeral: true });

      if (guildId) {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
        console.log(`✅ Refreshed ${commands.length} slash commands in test guild ${guildId}`);
        await interaction.editReply(`✅ Refreshed ${commands.length} slash commands in test guild.`);
      } else {
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log(`✅ Refreshed ${commands.length} global slash commands`);
        await interaction.editReply(`✅ Refreshed ${commands.length} global slash commands.`);
      }

    } catch (err) {
      console.error('❌ Error refreshing slash commands:', err);
      await interaction.editReply('❌ Failed to refresh commands. See logs.');
    }
  }
};
