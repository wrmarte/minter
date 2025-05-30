const { AttachmentBuilder } = require('discord.js');
const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');  // ✅ built-in flavorMap pulled
const fetch = require('node-fetch');

module.exports = {
  name: 'exp',
  async execute(message, args, { pg }) {
    const ownerId = process.env.BOT_OWNER_ID;
    const guildId = message.guild?.id ?? null;

    if (message.author.id !== ownerId) {
      return message.reply('❌ Only the bot owner can use this command.');
    }

    const name = args[0]?.toLowerCase();
    if (!name) {
      return message.reply('❌ Please specify an expression name.');
    }

    // 1️⃣ Check hardcoded flavorMap first
    if (flavorMap[name]) {
      const msg = getRandomFlavor(name, `<@${message.author.id}>`);
      return message.reply(msg);
    }

    // 2️⃣ Check PostgreSQL database for custom ones
    const res = await pg.query(`
      SELECT * FROM expressions 
      WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL) 
      ORDER BY RANDOM() LIMIT 1
    `, [name, guildId]);

    if (!res.rows.length) {
      return message.reply('❌ Unknown expression. Use valid keywords or saved expressions.');
    }

    const exp = res.rows[0];
    const userMention = `<@${message.author.id}>`;
    const customMessage = exp?.content?.includes('{user}')
      ? exp.content.replace('{user}', userMention)
      : `${userMention} is experiencing **"${name}"** energy today!`;

    if (exp?.type === 'image') {
      try {
        const imageRes = await fetch(exp.content);
        if (!imageRes.ok) throw new Error(`Image failed to load: ${imageRes.status}`);
        const file = new AttachmentBuilder(exp.content);
        return await message.reply({ content: customMessage, files: [file] });
      } catch (err) {
        console.error('❌ Image fetch error:', err.message);
        return await message.reply({ content: `⚠️ Image broken, but:\n${customMessage}` });
      }
    }

    return message.reply(customMessage);
  }
};



