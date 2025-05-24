const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('canvas');

const { JsonRpcProvider, Contract } = require('ethers');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)'
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexplus')
    .setDescription('Flex a collage of 6 random NFTs from a project')
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
      const chain = (network === 'base') ? 'base' : 'ethereum';
      const provider = new JsonRpcProvider(
        chain === 'base'
          ? 'https://mainnet.base.org'
          : 'https://eth.llamarpc.com'
      );

      const apiUrl = `https://api.reservoir.tools/tokens/v6?chain=${chain}&contract=${address}&limit=50&sortBy=floorAskPrice&includeTopBid=true&includeAttributes=true`;
      const headers = { 'x-api-key': process.env.RESERVOIR_API_KEY };
      const data = await fetch(apiUrl, { headers }).then(res => res.json());
      const tokens = data?.tokens?.filter(t => t.token?.image) || [];

      if (!tokens.length) {
        return interaction.editReply('⚠️ No tokens found to flex.');
      }

      const selected = tokens.sort(() => 0.5 - Math.random()).slice(0, 6).map(t => t.token.image);
      const images = await Promise.all(
        selected.map(async url => {
          try {
            return await loadImage(url);
          } catch {
            return null;
          }
        })
      );

      const canvas = createCanvas(900, 600);
      const ctx = canvas.getContext('2d');

      images.forEach((img, i) => {
        if (!img) return;
        const x = (i % 3) * 300;
        const y = Math.floor(i / 3) * 300;
        ctx.drawImage(img, x, y, 300, 300);
      });

      const buffer = await canvas.encode('png');
      const attachment = new AttachmentBuilder(buffer, { name: 'flexplus.png' });

      const embed = new EmbedBuilder()
        .setTitle(`🖼️ Flex Collage: ${name}`)
        .setDescription(`Here's a random collage from ${name}`)
        .setImage('attachment://flexplus.png')
        .setColor(network === 'base' ? 0x1d9bf0 : 0xf5851f)
        .setFooter({ text: 'Powered by PimpsDev' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (err) {
      console.error('❌ Error in /flexplus:', err);
      await interaction.editReply('⚠️ Something went wrong while generating the collage.');
    }
  }
};
