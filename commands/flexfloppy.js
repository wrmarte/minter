// ✅ Clean direct flexfloppy with server restriction logic + trigger compatibility
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
const { buildFloppyCard } = require('../utils/canvas/floppyRenderer');

const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
const ADRIAN_GUILD_ID = process.env.ADRIAN_GUILD_ID;

// Normalize Token ID input → decimal string (supports decimal or 0x-hex; no precision loss)
function normalizeTokenIdInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Invalid token ID: empty');

  // hex (0x...)
  if (/^0x[0-9a-f]+$/i.test(raw)) {
    try {
      return BigInt(raw).toString(10);
    } catch {
      throw new Error('Invalid token ID: bad hex');
    }
  }

  // pure decimal
  if (/^\d+$/.test(raw)) {
    // strip leading zeros but keep "0" if all zeros
    const dec = raw.replace(/^0+/, '') || '0';
    return dec;
  }

  throw new Error('Invalid token ID: use decimal or 0x-hex (e.g., 1234 or 0x4d2)');
}

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
    // 🛠️ Change: tokenid is now STRING to avoid numeric overflow that breaks rarity/rank
    .addStringOption(opt =>
      opt.setName('tokenid')
        .setDescription('Token ID (decimal or 0x-hex)')
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
        const res = await pg.query(
          `SELECT name FROM flex_projects WHERE (guild_id = $1 OR guild_id IS NULL) AND network = 'base'`,
          [guildId]
        );
        const projectNames = res.rows
          .map(row => row.name)
          .filter(Boolean)
          .filter(name => name.toLowerCase().includes((focused.value || '').toLowerCase()))
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
      tokenId: interaction.options.getString('tokenid'), // ← string now
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

      // Case-insensitive project selection (keeps your existing precedence: guild-specific beats global)
      const result = await pg.query(
        `SELECT * FROM flex_projects
         WHERE (guild_id = $1 OR guild_id IS NULL) AND LOWER(name) = LOWER($2) AND network = 'base'
         ORDER BY guild_id DESC LIMIT 1`,
        [guildId, name]
      );

      if (!result.rows.length) {
        return await editReplyMethod('❌ Project not found. Use `/addflex` first.');
      }

      const row = result.rows[0];
      const contractAddress = row.address;
      const collectionName = row.display_name || row.name;
      const chain = (row.network || 'base').toLowerCase();

      if (chain !== 'base') {
        return await editReplyMethod('⚠️ FlexFloppy is only supported for Base network NFTs right now.');
      }

      // 🔒 Token ID normalization to a safe decimal string (prevents rank mismatch)
      let tokenIdDec;
      try {
        tokenIdDec = normalizeTokenIdInput(tokenId);
      } catch (e) {
        return await editReplyMethod(`❌ ${e.message}`);
      }

      // Color validation (optional)
      const allowed = new Set(['red','yellow','green','blue','purple','black']);
      const picked = color && allowed.has(color) ? color : null;
      const floppyPath = picked ? path.resolve(__dirname, `../assets/floppies/floppy-${picked}.png`) : null;

      // Pass a DECIMAL STRING tokenId to the renderer so any rarity/rank API matches the correct token
      const imageBuffer = await buildFloppyCard(contractAddress, tokenIdDec, collectionName, chain, floppyPath);

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




