// ✅ root/listeners/fftrigger.js
const { buildFloppyCard } = require('../utils/canvas/floppyRenderer');
const { AttachmentBuilder } = require('discord.js');
const path = require('path');
const pg = require('../services/pg'); // Adjust path if needed

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim();
    const ffMatch = content.match(/^ff-(.+)$/i);
    if (!ffMatch) return;

    const flexName = ffMatch[1].toLowerCase();

    try {
      const result = await pg.query(
        `SELECT * FROM flex_projects WHERE name = $1 AND network = 'base' ORDER BY guild_id DESC LIMIT 1`,
        [flexName]
      );

      if (!result.rows.length) {
        return await message.reply('❌ Flex project not found.');
      }

      const { address, display_name, name, network } = result.rows[0];
      const contractAddress = address;
      const collectionName = display_name || name;
      const chain = network.toLowerCase();

      if (chain !== 'base') {
        return await message.reply('⚠️ FF trigger only supports Base NFTs.');
      }

      const tokenId = Math.floor(Math.random() * 1000) + 1;
      const floppyPath = null;

      const imageBuffer = await buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath);

      const attachment = new AttachmentBuilder(imageBuffer, { name: `ff-trigger.png` });
      await message.reply({ files: [attachment] });

    } catch (err) {
      console.error('❌ ff-trigger error:', err);
      await message.reply('❌ Failed to generate FF trigger floppy.');
    }
  });
};
