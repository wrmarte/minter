const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('helpmint')
    .setDescription('Show help menu for all mint, sale, and token tracking commands'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('📖 Mint & Sale Tracker Help Menu')
      .setDescription('All the power tools you need to monitor minting, sales, and token movement across the Base network. 💥')
      .addFields(
        {
          name: '🧱 Mint Commands',
          value:
            '• `/trackmint` — Track a contract with token + mint price\n' +
            '• `/untrackmint` — Stop tracking a contract\n' +
            '• `/channels` — View all alert channels for a tracked contract\n' +
            '• `/untrackchannel` — Unsubscribe this channel from mint alerts\n' +
            '• `/mintest` — Simulate a mint alert'
        },
        {
          name: '💸 Sale Commands',
          value:
            '• `/selltest` — Simulate a sale alert'
        },
        {
          name: '💰 Token Sale Tracker',
          value:
            '• `/tracktoken` — Track buys of a specific token\n' +
            '• `/untracktoken` — Stop tracking a token in this server'
        },
        {
          name: '🆘 Help',
          value: '• `/helpmint` — Show this help menu'
        }
      )
      .setColor(0x00b0f4)
      .setThumbnail('https://iili.io/3PMk5GV.jpg')
      .setFooter({ text: 'Base Network • Mint & Sale Bot by PimpsDev' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};

