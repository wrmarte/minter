const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('helpmint')
    .setDescription('Show help for minting commands'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('📖 Mint Bot Help Menu')
      .setDescription('Master the art of mint and sale tracking 🔍🧪')
      .addFields(
        { name: '📌 /trackmint', value: 'Track a contract with token + price' },
        { name: '🚫 /untrackmint', value: 'Stop tracking a contract' },
        { name: '📡 /channels', value: 'See all alert channels for a contract' },
        { name: '📤 /untrackchannel', value: 'Unsubscribe this channel' },
        { name: '🧪 /mintest', value: 'Simulate a mint' },
        { name: '💸 /selltest', value: 'Simulate a sale' },
        { name: '🆘 /helpmint', value: 'Show help menu' }
      )
      .setColor(0x00b0f4)
      .setThumbnail('https://iili.io/3PMk5GV.jpg')
      .setFooter({ text: 'Base Network • Mint & Sale Bot by PimpsDev' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
};
