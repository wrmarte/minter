const { AttachmentBuilder } = require('discord.js');
const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');  // ✅ Unified flavorMap

module.exports = {
  name: 'exp',
  async execute(message, args, { pg }) {
    const name = args[0]?.toLowerCase();
    const guildId = message.guild?.id ?? null;
    const userMention = `<@${message.author.id}>`;

    if (!name) {
      return message.reply({ content: '❌ Please provide an expression name. Example: `!exp rich`' });
    }

    // Check DB first
    let res = await pg.query(
      `SELECT * FROM expressions WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL) ORDER BY RANDOM() LIMIT 1`,
      [name, guildId]
    );

    let customMessage;
    if (res.rows.length > 0) {
      const exp = res.rows[0];
      customMessage = exp?.content?.includes('{user}')
        ? exp.content.replace('{user}', userMention)
        : getRandomFlavor(name, userMention) || `💥 ${userMention} is experiencing **"${name}"** energy today!`;

      if (exp?.type === 'image') {
        try {
          const file = new AttachmentBuilder(exp.content);
          return await message.reply({ content: customMessage, files: [file] });
        } catch (err) {
          console.error('❌ Image fetch error:', err.message);
          return await message.reply({ content: `⚠️ Image broken, but:\n${customMessage}` });
        }
      }

      return message.reply({ content: customMessage });
    }

    // If not in DB, check built-in flavorMap fallback
    if (flavorMap[name]) {
      const builtMessage = getRandomFlavor(name, userMention);
      return message.reply({ content: builtMessage });  // ✅ wrap into { content: }
    }

    return message.reply({ content: '❌ Unknown expression. Use valid keywords or saved expressions.' });
  }
};


