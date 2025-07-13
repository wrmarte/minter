const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildUltraFlexCard } = require('../services/ultraFlexService');
const { buildFloppyFlexCard } = require('../services/floppyFlexService');

function getFlexService(chain) {
  switch (chain) {
    case 'base': return require('../services/flexcardBaseS');
    case 'eth': return require('../services/flexcardEthS');
    case 'ape': return require('../services/flexcardApeS');
    default: throw new Error(`Unsupported chain: ${chain}`);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexcard')
    .setDescription('Generate a FlexCard for any NFT.')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Project name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(opt =>
      opt.setName('tokenid')
        .setDescription('Token ID')
        .setRequired(true)
    )
    .addBooleanOption(opt =>
      opt.setName('ultra')
        .setDescription('Enable Ultra Style')
    )
    .addBooleanOption(opt =>
      opt.setName('floppy')
        .setDescription('Enable Floppy Style')
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenId = interaction.options.getInteger('tokenid');
    const ultra = interaction.options.getBoolean('ultra');
    const floppy = interaction.options.getBoolean('floppy');
    const userIsOwner = interaction.user.id === process.env.BOT_OWNER_ID;

    try {
      await interaction.deferReply({ ephemeral: false }).catch(() => {});

      const result = await pg.query(
        `SELECT * FROM flex_projects WHERE (guild_id = $1 OR guild_id IS NULL) AND name = $2 ORDER BY guild_id DESC LIMIT 1`,
        [interaction.guild.id, name]
      );

      if (!result.rows.length) {
        if (!interaction.replied) {
          return await interaction.editReply('❌ Project not found. Use `/addflex` first.');
        }
        return;
      }

      const { address, display_name, name: storedName, network } = result.rows[0];
      const contractAddress = address;
      const collectionName = display_name || storedName;
      const chain = network.toLowerCase();

      if ((ultra || floppy) && !userIsOwner) {
        return await interaction.editReply('🚫 Only the bot owner can use Ultra or Floppy mode for now.');
      }

      if (ultra && floppy) {
        return await interaction.editReply('❌ You can’t use both Ultra and Floppy styles at the same time.');
      }

      let imageBuffer;

      if (ultra) {
        imageBuffer = await buildUltraFlexCard(contractAddress, tokenId, collectionName, chain);
      } else if (floppy) {
        imageBuffer = await buildFloppyFlexCard(contractAddress, tokenId, collectionName, chain);
      } else {
        const { buildFlexCard } = getFlexService(chain);
        imageBuffer = await buildFlexCard(contractAddress, tokenId, collectionName, pg, interaction.guild.id);
      }

      const attachment = new AttachmentBuilder(imageBuffer, {
        name: `${ultra ? 'ultra' : floppy ? 'floppy' : 'default'}flexcard.png`
      });

      return await interaction.editReply({ files: [attachment] });

    } catch (err) {
      console.error('❌ FlexCard error:', err);

      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Failed to generate FlexCard.', ephemeral: true });
        } else {
          await interaction.editReply({ content: '❌ Failed to generate FlexCard.' });
        }
      } catch (e) {
        console.warn('⚠️ Could not send error message:', e.message);
      }
    }
  }
};






