const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('helpmint')
    .setDescription('Show help menu for minting, sales, flexing, and token tracking'),

  async execute(interaction) {
    const clientId = '1369295340456640552';

    const commandLink = (cmd) => `</${cmd}:${clientId}>`;

    const embed = new EmbedBuilder()
      .setTitle('📖 Mint & Sale Bot Command Guide')
      .setDescription('Master mint alerts, Flex NFT, track tokens & NFT Sales across the Base/ETH network.')
      .addFields(
        {
          name: '🧱 MINTING COMMANDS',
          value:
            `• ${commandLink('trackmint')} — Track an NFT contract with token + mint price\n` +
            `• ${commandLink('untrackmint')} — Stop tracking a contract\n` +
            `• ${commandLink('channels')} — View alert channels for a contract\n` +
            `• ${commandLink('untrackchannel')} — Unsubscribe this channel\n` +
            `• ${commandLink('mintest')} — Simulate a mint alert`
        },
        {
          name: '💸 SALE COMMANDS',
          value:
            `• ${commandLink('selltest')} — Simulate a sale alert\n` +
            `• ${commandLink('tracksale')} — Track NFT sales`
        },
        {
          name: '💰 TOKEN TRACKER',
          value:
            `• ${commandLink('tracktoken')} — Track token buys and display alerts\n` +
            `• ${commandLink('untracktoken')} — Stop tracking a token`
        },
        {
          name: '🖼️ FLEX COMMANDS',
          value:
            `• ${commandLink('addflex')} — Register a flex NFT contract to your server\n` +
            `• ${commandLink('flex')} — Display a random minted NFT from your tracked flex project\n` +
            `• ${commandLink('flexplus')} — Show 6 random NFTs from your flex project as a collage\n` +
            `• ${commandLink('addflexduo')} — Register two paired contracts as a duo\n` +
            `• ${commandLink('flexduo')} — Display matching NFTs from two paired collections`
        },
        {
          name: '🛠️ UTILITIES',
          value:
            `• ${commandLink('ping')} — Check if the bot is alive\n` +
            `• ${commandLink('helpmint')} — Show this help menu`
        }
      )
      .setColor(0x00b0f4)
      .setThumbnail('https://iili.io/3PMk5GV.jpg')
      .setFooter({ text: 'Powered by PimpsDev 🧪' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};




      




