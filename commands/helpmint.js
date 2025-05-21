const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('helpmint')
    .setDescription('Show all available mint bot commands'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle('🤖 Mint Bot Help Menu')
      .setColor(0x3498db)
      .setDescription(`
Here’s what I can do, boss:

🟢 **/trackmint** — Track mints for a contract in this channel  
🔴 **/untrackmint** — Stop tracking mints for a contract  
📵 **/untrackchannel** — Remove this channel from all tracking  
🧪 **/mintest** — Simulate a mint embed (test only)  
💸 **/selltest** — Simulate a token-based sale embed (test only)  
📺 **/channels** — List all channels tracking each contract  
❓ **/helpmint** — You're looking at it!
      `)
      .setFooter({ text: 'Powered by PimpsDev • Stay minty 🍃' });

    await interaction.editReply({ embeds: [embed] });
  }
};
