const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('helpmint')
    .setDescription('Show help menu for minting, sales, flexing, token tracking, and AI tools'),

  async execute(interaction) {
    const today = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });

    const embed = new EmbedBuilder()
      .setTitle('📖 Minter V4.4 Ultimate Command Guide')
      .setDescription('Master mint alerts, Flex NFTs, track tokens & sales, swap tokens, generate expressions, and use AI-powered features across Base/ETH.')
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
            '• `/flex` — Display a random minted NFT from your flex project\n' +
            '• `/flexplus` — Show 6 random NFTs as a collage\n' +
            '• `/addflexduo` — Register two paired contracts as duo\n' +
            '• `/flexduo` — Display matching NFTs from duo collections\n' +
            '• `/flexspin` — Spin your NFT with rarity overlay & animation'
        },
        {
          name: '🎭 EXPRESSION COMMANDS',
          value:
            '• `/exp` — Generate fun expression / mood\n' +
            '• `/expadd` — Add your custom expressions'
        },
        {
          name: '🧪 AI / EXPERIMENTAL',
          value:
            '• `/analyze` — AI guess traits for unrevealed NFTs\n' +
            '• `/flexbattle` — Royale rarity battle (WIP/Roadmap)'
        },
        {
          name: '🔄 SWAP TOOL (Owner only)',
          value:
            '• `/swap` — Swap tokens via Uniswap on Base'
        },
        {
          name: '🛠️ UTILITIES',
          value:
            '• `/ping` — Check bot status\n' +
            '• `/status` — View bot system health\n' +
            '• `/helpmint` — Show this full help menu'
        }
      )
      .setColor(0x00b0f4)
      .setThumbnail('https://iili.io/3PMk5GV.jpg')
      .setFooter({ text: 'Powered by PimpsDev 🧪' })
      .setTimestamp();

    await interaction.reply({
      embeds: [embed],
      flags: 64 // Ephemeral
    });
  }
};







      




