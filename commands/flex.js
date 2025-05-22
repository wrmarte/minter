const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flex')
    .setDescription('Flex a random NFT from a project')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Project name').setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();

    await interaction.deferReply();

    try {
      const res = await pg.query(`SELECT * FROM flex_projects WHERE name = $1`, [name]);
      if (!res.rows.length) {
        return interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, network } = res.rows[0];
      const apiUrl = `https://api.reservoir.tools/tokens/v6?contract=${address}&limit=50&sortBy=floorAskPrice&acceptsParams=true`;
      const headers = { 'x-api-key': process.env.RESERVOIR_API_KEY };

      const data = await fetch(apiUrl, { headers }).then(res => res.json());
      const tokens = data?.tokens?.filter(t => t.token?.tokenId) || [];

      if (!tokens.length) {
        return interaction.editReply('⚠️ No minted NFTs found yet for this contract.');
      }

      const random = tokens[Math.floor(Math.random() * tokens.length)].token;

      const embed = new EmbedBuilder()
        .setTitle(`🖼️ Flexing from ${name}`)
        .setDescription(`Token #${random.tokenId}`)
        .setImage(random.image)
        .setURL(`https://opensea.io/assets/${network}/${address}/${random.tokenId}`)
        .setColor(0x3498db)
        .setFooter({ text: `Network: ${network.toUpperCase()}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Error in /flex:', err);
      await interaction.editReply('⚠️ Something went wrong.');
    }
  }
};
