const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

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
      const chain = network === 'base' ? 'base' : 'eth';

      const url = `https://deep-index.moralis.io/api/v2.2/nft/${address}?chain=${chain}&format=decimal&limit=50`;
      const headers = {
        accept: 'application/json',
        'X-API-Key': process.env.MORALIS_API_KEY
      };

      const moralisData = await fetch(url, { headers }).then(res => res.json());
      const nfts = moralisData?.result || [];

      if (!nfts.length) {
        return interaction.editReply('⚠️ No NFTs found via Moralis.');
      }

      const selected = nfts.sort(() => 0.5 - Math.random()).slice(0, 6);
      const images = await Promise.all(
        selected.map(async nft => {
          let meta = {};
          try {
            if (nft.metadata) {
              meta = JSON.parse(nft.metadata || '{}');
            }
            if ((!meta || !meta.image) && nft.token_uri) {
              const uri = nft.token_uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
              meta = await fetch(uri).then(res => res.json());
            }
          } catch {
            return null;
          }

          let img = null;
          if (meta.image) {
            img = meta.image.startsWith('ipfs://')
              ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
              : meta.image;
          } else if (meta.image_url) {
            img = meta.image_url.startsWith('ipfs://')
              ? meta.image_url.replace('ipfs://', 'https://ipfs.io/ipfs/')
              : meta.image_url;
          }

          try {
            return await loadImage(img);
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

      const buffer = canvas.toBuffer('image/png');
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


