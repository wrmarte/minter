// ✅ listeners/fftrigger.js — ff-projectname or ff-projectname-id, only minted token IDs
const { AttachmentBuilder } = require('discord.js');
const { buildFloppyCard } = require('../utils/canvas/floppyRenderer');
const path = require('path');
const { Contract } = require('ethers');
const { getProvider } = require('../services/providerM');

module.exports = (client) => {
  client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    const guildId = message.guild.id;
    const trigger = message.content.trim().toLowerCase();
    if (!trigger.startsWith('ff-')) return;

    const [rawName, rawTokenId] = trigger.replace('ff-', '').split('-');
    const projectName = rawName?.trim();
    const tokenIdInput = parseInt(rawTokenId);

    if (!projectName) return;

    try {
      const pg = client.pg;
      const result = await pg.query(
        `SELECT * FROM flex_projects WHERE (guild_id = $1 OR guild_id IS NULL) AND name = $2 AND network = 'base' ORDER BY guild_id DESC LIMIT 1`,
        [guildId, projectName]
      );

      const row = result.rows[0];
      if (!row) {
        return message.reply('❌ Flex project not found. Use `/addflex` first.').catch(() => {});
      }

      const { address, display_name, name: storedName, network } = row;
      const contractAddress = address;
      const collectionName = display_name || storedName || projectName;
      const chain = network?.toLowerCase() || 'base';
      if (!contractAddress || chain !== 'base') {
        return message.reply('⚠️ Invalid contract or unsupported network.').catch(() => {});
      }

      let totalSupply = 200; // Default fallback
      try {
        const provider = getProvider(chain);
        const erc721Abi = ['function totalSupply() view returns (uint256)'];
        const contract = new Contract(contractAddress, erc721Abi, provider);
        totalSupply = Number(await contract.totalSupply());
        if (!totalSupply || isNaN(totalSupply) || totalSupply <= 0) totalSupply = 500;
      } catch (err) {
        console.warn(`⚠️ totalSupply fetch failed: ${err.message}`);
      }

      const tokenId = Number.isInteger(tokenIdInput) && tokenIdInput > 0
        ? tokenIdInput
        : Math.floor(Math.random() * totalSupply) + 1;

      const floppyPath = null; // Force random floppy color
      const imageBuffer = await buildFloppyCard(contractAddress, tokenId, collectionName, chain, floppyPath);
      const attachment = new AttachmentBuilder(imageBuffer, { name: `floppyflexcard.png` });

      await message.channel.send({ files: [attachment] });
    } catch (err) {
      console.error('❌ ff-trigger-command error:', err);
      message.reply('⚠️ Something went wrong processing that floppy.').catch(() => {});
    }
  });
};



