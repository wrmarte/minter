// ✅ listeners/fftrigger.js — Fully patched dual-mode logic (random + specific token ID)
const { AttachmentBuilder } = require('discord.js');
const { buildFloppyCard } = require('../utils/canvas/floppyRenderer');
const path = require('path');

const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
const ADRIAN_GUILD_ID = process.env.ADRIAN_GUILD_ID;

module.exports = (client) => {
  client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const trigger = message.content.trim().toLowerCase();
    if (!trigger.startsWith('ff-')) return;

    const cleanTrigger = trigger.replace('ff-', '').trim();
    if (!cleanTrigger) return;

    // ✅ Detect project name and optional token ID
    let projectName = cleanTrigger;
    let tokenId = null;

    if (cleanTrigger.includes('-')) {
      const parts = cleanTrigger.split('-');
      projectName = parts[0];
      tokenId = parseInt(parts[1]);
      if (isNaN(tokenId) || tokenId <= 0) tokenId = null;
    }

    try {
      const pg = client.pg;
      const result = await pg.query(
        `SELECT * FROM flex_projects WHERE (guild_id = $1 OR guild_id IS NULL) AND name = $2 AND network = 'base' ORDER BY guild_id DESC LIMIT 1`,
        [guildId, projectName]
      );

      if (!result.rows.length && message.author.id !== BOT_OWNER_ID) {
        return message.reply('❌ Flex project not found. Use `/addflex` first.').catch(() => {});
      }

      if (message.author.id !== BOT_OWNER_ID && guildId !== ADRIAN_GUILD_ID) {
        return message.reply('🚫 This command is restricted to Adrian server.').catch(() => {});
      }

      const { address, display_name, name: storedName, network } = result.rows[0] || {};
      const contractAddress = address;
      const collectionName = display_name || storedName || projectName;
      const chain = network?.toLowerCase() || 'base';
      if (chain !== 'base') return;

      if (!tokenId) tokenId = Math.floor(Math.random() * 500) + 1;

      const floppyPath = null; // Random color handled inside floppyRenderer
      const imageBuffer = await buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath);

      const attachment = new AttachmentBuilder(imageBuffer, { name: `floppyflexcard.png` });
      await message.channel.send({ files: [attachment] });
    } catch (err) {
      console.error('❌ ff-trigger-command error:', err);
    }
  });
};


