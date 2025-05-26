const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('helpmint')
    .setDescription('Show help menu for minting, sales, flexing, and token tracking'),

  async execute(interaction) {
    const today = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });

    const embed = new EmbedBuilder()
      .setTitle('📖 Mint & Sale Bot Command Guide')
      .setDescription('Master mint alerts, Flex NFT, track tokens & NFT Sales across the Base/ETH network.')
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
            '• `/selltest` — Simulate a sale alert\n' +
            '• `/tracksale` — Track NFT sales'
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
            '• `/addflex` — Register a flex NFT contract to your server\n' +
            '• `/flex` — Display a random minted NFT from your tracked flex project\n' +
            '• `/flexplus` — Show 6 random NFTs from your flex project as a collage\n' +
            '• `/addflexduo` — Register two paired contracts as a duo\n' +
            '• `/flexduo` — Display matching NFTs from two paired collections'
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
      .setFooter({ text: 'Powered by PimpsDev 🧪' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};





      




