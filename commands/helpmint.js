const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('helpmint')
    .setDescription('Show help menu for minting, sales, flexing, and token tracking'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('📖 Mint & Sale Bot Command Guide')
      .setDescription('Master your minting ops, flex NFTs, and track token buys across the Base network. Powered by **PimpsDev** 🧪')
      .addFields(
        {
          name: '🧱 MINTING COMMANDS',
          value:
            '• `/trackmint` — Track an NFT contract with token + mint price\n' +
            '• `/untrackmint` — Stop tracking a contract\n' +
            '• `/channels` — View alert channels for a contract\n' +
            '• `/untrackchannel` — Unsubscribe this channel\n' +
            '• `/mintest` — Simulate a mint alert'
        },
        {
          name: '💸 SALE COMMANDS',
          value:
            '• `/selltest` — Simulate a sale alert'
        },
        {
          name: '💰 TOKEN TRACKER',
          value:
            '• `/tracktoken` — Track token buys and display alerts\n' +
            '• `/untracktoken` — Stop tracking a token'
        },
        {
          name: '🖼️ FLEX COMMANDS',
          value:
            '• `/addflex` — Register a flex NFT contract to your server [NEW]\n' +
            '• `/flex` — Display a random minted NFT from your tracked flex project'
        },
        {
          name: '🛠️ UTILITIES',
          value:
            '• `/ping` — Check if the bot is alive\n' +
            '• `/helpmint` — Show this help menu'
        }
      )
      .setColor(0x00b0f4)
      .setThumbnail('https://iili.io/3PMk5GV.jpg')
      .setFooter({ text: 'Base Network • Mint & Sale Bot by PimpsDev' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};


