// ✅ Clean direct flexfloppy with server restriction logic + trigger compatibility
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
const { buildFloppyCard } = require('../utils/canvas/floppyRenderer');

const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
const ADRIAN_GUILD_ID = process.env.ADRIAN_GUILD_ID;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flexfloppy')
    .setDescription('Generate a Floppy FlexCard for any NFT on Base network (Adrian server only).')
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
    .addStringOption(opt =>
      opt.setName('color')
        .setDescription('Floppy Color (red, yellow, green, blue, purple, black)')
        .setRequired(false)
    ),

  async autocomplete(interaction, pg) {
    const focused = interaction.options.getFocused(true);
    const guildId = interaction.guild?.id;

    if (focused.name === 'name') {
      try {
        const res = await pg.query(`SELECT name FROM flex_projects WHERE (guild_id = $1 OR guild_id IS NULL) AND network = 'base'`, [guildId]);
        const projectNames = res.rows
          .map(row => row.name)
          .filter(Boolean)
          .filter(name => name.toLowerCase().includes(focused.value.toLowerCase()))
          .slice(0, 25)
          .map(name => ({ name, value: name }));
        await interaction.respond(projectNames);
      } catch (err) {
        console.error('❌ FlexFloppy autocomplete error:', err);
        await interaction.respond([]);
      }
    }
  },

  async execute(interaction) {
    await module.exports.executeFlex(interaction.client, interaction, {
      userId: interaction.user.id,
      guildId: interaction.guild?.id,
      name: interaction.options.getString('name'),
      tokenId: interaction.options.getInteger('tokenid'),
      color: interaction.options.getString('color')?.toLowerCase() || null,
      deferReply: true,
      replyMethod: (content) => interaction.reply(content),
      editReplyMethod: (content) => interaction.editReply(content)
    });
  },

  async executeFlex(client, interactionOrMessage, options) {
    const pg = client.pg;
    const { userId, guildId, name, tokenId, color, deferReply, replyMethod, editReplyMethod } = options;

    if (userId !== BOT_OWNER_ID && guildId !== ADRIAN_GUILD_ID) {
      return await replyMethod({
        content: '🚫 This command is restricted to Adrian server.',
        ephemeral: true
      });
    }

    try {
      if (deferReply && interactionOrMessage.deferReply) {
        await interactionOrMessage.deferReply({ flags: 0 }).catch(() => {});
      }

      const result = await pg.query(
        `SELECT * FROM flex_projects WHERE (guild_id = $1 OR guild_id IS NULL) AND name = $2 AND network = 'base' ORDER BY guild_id DESC LIMIT 1`,
        [guildId, name.toLowerCase()]
      );

      if (!result.rows.length) {
        return await editReplyMethod('❌ Project not found. Use `/addflex` first.');
      }

      const { address, display_name, name: storedName, network } = result.rows[0];
      const contractAddress = address;
      const collectionName = display_name || storedName;
      const chain = network.toLowerCase();

      if (chain !== 'base') {
        return await editReplyMethod('⚠️ FlexFloppy is only supported for Base network NFTs right now.');
      }

      const floppyPath = color ? path.resolve(__dirname, `../assets/floppies/floppy-${color}.png`) : null;
      const imageBuffer = await buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath);

      const attachment = new AttachmentBuilder(imageBuffer, { name: `floppyflexcard.png` });
      return await editReplyMethod({ files: [attachment] });
    } catch (err) {
      console.error('❌ FlexFloppy error:', err);
      if (!interactionOrMessage.replied && replyMethod) {
        await replyMethod({ content: '❌ Failed to generate FlexFloppy.', flags: 64 }).catch(() => {});
      }
    }
  }
};




