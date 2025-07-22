const { SlashCommandBuilder } = require('discord.js');
const { REST, Routes } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('🔄 Refresh slash commands')
    .addStringOption(option =>
      option.setName('scope')
        .setDescription('Where to refresh commands')
        .setRequired(true)
        .addChoices(
          { name: 'Global', value: 'global' },
          { name: 'Test Guild Only', value: 'test' },
          { name: 'Both', value: 'both' }
        )
    ),

  async execute(interaction) {
    // ✅ Restrict to owner
    if (interaction.user.id !== process.env.BOT_OWNER_ID) {
      return interaction.reply({ content: '🚫 You are not authorized to run this command.', ephemeral: true });
    }

    const client = interaction.client;
    const token = process.env.DISCORD_BOT_TOKEN;
    const clientId = process.env.CLIENT_ID;
    const guildId = process.env.TEST_GUILD_ID;

    const scope = interaction.options.getString('scope');
    const rest = new REST({ version: '10' }).setToken(token);
    const commands = client.commands.map(cmd => cmd.data.toJSON());

    await interaction.reply({ content: `⏳ Refreshing commands for \`${scope}\`...`, ephemeral: true });

    try {
      if (scope === 'global' || scope === 'both') {
        await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log(`✅ Registered ${commands.length} global commands`);
      }

      if ((scope === 'test' || scope === 'both') && guildId) {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
        console.log(`✅ Registered ${commands.length} test guild commands to ${guildId}`);
      }

      await interaction.editReply(`✅ Refreshed commands for \`${scope}\`.`);
    } catch (err) {
      console.error('❌ Slash refresh failed:', err);
      await interaction.editReply('❌ Command refresh failed. Check logs.');
    }
  }
};

