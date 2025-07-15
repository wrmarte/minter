// ✅ listeners/fftrigger.js — Fully patched with validation and restrictions
const { AttachmentBuilder } = require('discord.js');
const { buildFloppyCard } = require('../utils/canvas/floppyRenderer');
const path = require('path');

const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
const ADRIAN_GUILD_ID = process.env.ADRIAN_GUILD_ID;

module.exports = (client) => {
  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const guildId = message.guild.id;
    const trigger = message.content.trim().toLowerCase();
    if (!trigger.startsWith('ff-')) return;

    const projectName = trigger.replace('ff-', '').trim();
    if (!projectName) return;

    try {
      const pg = client.pg;
      const result = await pg.query(
        `SELECT * FROM flex_projects WHERE (guild_id = $1 OR guild_id IS NULL) AND name = $2 AND network = 'base' ORDER BY guild_id DESC LIMIT 1`,
        [guildId, projectName]
      );

      const row = result.rows[0];

      if (!row && message.author.id !== BOT_OWNER_ID) {
        return message.reply('❌ Flex project not found. Use `/addflex` first.').catch(() => {});
      }

      if (message.author.id !== BOT_OWNER_ID && guildId !== ADRIAN_GUILD_ID) {
        return message.reply('🚫 This command is restricted to Adrian server.').catch(() => {});
      }

      if (!row) {
        return message.reply('⚠️ No contract address available for this project.').catch(() => {});
      }

      const { address, display_name, name: storedName, network } = row;
      const contractAddress = address;
      const collectionName = display_name || storedName || projectName;
      const chain = network?.toLowerCase() || 'base';

      if (!contractAddress || chain !== 'base') {
        return message.reply('⚠️ Invalid contract or unsupported network.').catch(() => {});
      }

      const randomTokenId = Math.floor(Math.random() * 500) + 1;
      const floppyPath = null; // Force random floppy color

      const imageBuffer = await buildFloppyCard(contractAddress, randomTokenId, collectionName, chain, floppyPath);
      const attachment = new AttachmentBuilder(imageBuffer, { name: `floppyflexcard.png` });

      await message.channel.send({ files: [attachment] });
    } catch (err) {
      console.error('❌ ff-trigger-command error:', err);
      message.reply('⚠️ Something went wrong processing that floppy.').catch(() => {});
    }
  });
};



