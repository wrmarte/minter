const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');

// Predefined experiences and hosted image links (add more as needed)
const expMap = {
  rich: {
    url: 'https://your-railway-domain.com/images/exp-rich.png',
    message: '💸 {user} feeling **rich** today!'
  },
  poor: {
    url: 'https://your-railway-domain.com/images/exp-poor.png',
    message: '💀 {user} is **down bad** today...'
  },
  blessed: {
    url: 'https://your-railway-domain.com/images/exp-blessed.png',
    message: '🌈 {user} is feeling **blessed**!'
  }
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('exp')
    .setDescription('Show a visual experience vibe')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Experience name (e.g., "rich")')
        .setRequired(true)
    ),

  async execute(interaction) {
    const ownerId = process.env.BOT_OWNER_ID;
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: '❌ Only the bot owner can use this command.', ephemeral: true });
    }

    const name = interaction.options.getString('name').toLowerCase();
    const exp = expMap[name];

    if (!exp) {
      return interaction.reply({ content: '❌ Unknown experience. Try one like "rich", "poor", or "blessed".' });
    }

    const image = new AttachmentBuilder(exp.url);
    const message = exp.message.replace('{user}', `<@${interaction.user.id}>`);

    await interaction.reply({ content: message, files: [image] });
  }
};
