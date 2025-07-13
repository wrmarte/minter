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
    .setName('flexfloppy')
    .setDescription('Generate a Floppy FlexCard for any NFT on Base network.')
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
    ),

  async autocomplete(interaction, pg) {
    const focused = interaction.options.getFocused(true);
    const guildId = interaction.guild?.id;

    if (focused.name === 'name') {
      const res = await pg.query(`SELECT name FROM flex_projects WHERE (guild_id = $1 OR guild_id IS NULL) AND network = 'base'`, [guildId]);
      const projectNames = res.rows
        .map(row => row.name)
        .filter(Boolean)
        .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
        .slice(0, 25)
        .map(name => ({ name, value: name }));
      await interaction.respond(projectNames);
    }
  },

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const tokenId = interaction.options.getInteger('tokenid');
    const ultra = interaction.options.getBoolean('ultra');
    const userIsOwner = interaction.user.id === process.env.BOT_OWNER_ID;

    console.log(`FlexFloppy Debug → User ID: ${interaction.user.id}, BOT_OWNER_ID: ${process.env.BOT_OWNER_ID}`);

    try {
      await interaction.deferReply({ flags: 0 }).catch(() => {});

      const result = await pg.query(
        `SELECT * FROM flex_projects WHERE (guild_id = $1 OR guild_id IS NULL) AND name = $2 AND network = 'base' ORDER BY guild_id DESC LIMIT 1`,
        [interaction.guild.id, name]
      );

      if (!result.rows.length) {
        return await interaction.editReply('❌ Project not found. Use `/addflex` first.');
      }

      const { address, display_name, name: storedName, network } = result.rows[0];
      const contractAddress = address;
      const collectionName = display_name || storedName;
      const chain = network.toLowerCase();

      if (chain !== 'base') {
        return await interaction.editReply('⚠️ FlexFloppy is only supported for Base network NFTs right now.');
      }

      if (ultra && !userIsOwner) {
        return await interaction.editReply('🚫 Only the bot owner can use Ultra mode in FlexFloppy.');
      }

      let imageBuffer;

      if (ultra) {
        imageBuffer = await buildUltraFlexCard(contractAddress, tokenId, collectionName, chain);
      } else {
        imageBuffer = await buildFloppyFlexCard(contractAddress, tokenId, collectionName, chain);
      }

      const attachment = new AttachmentBuilder(imageBuffer, {
        name: `${ultra ? 'ultra' : 'floppy'}flexcard.png`
      });

      return await interaction.editReply({ files: [attachment] });

    } catch (err) {
      console.error('❌ FlexFloppy error:', err);
      if (!interaction.replied) {
        await interaction.reply({ content: '❌ Failed to generate FlexFloppy.', flags: 64 }).catch(() => {});
      }
    }
  }
};

