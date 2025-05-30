const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');
const { AttachmentBuilder } = require('discord.js');

module.exports = (client, pg) => {
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // Parse non-slash message
    if (!message.content.startsWith('!exp ')) return;

    const args = message.content.slice(5).trim().split(/\s+/);
    const name = args[0]?.toLowerCase();
    const guildId = message.guild?.id ?? null;
    const userMention = `<@${message.author.id}>`;

    if (!name) {
      return message.reply({ content: '❌ Please provide an expression name. Example: `!exp rich`' });
    }

    try {
      const res = await pg.query(
        `SELECT * FROM expressions WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL) ORDER BY RANDOM() LIMIT 1`,
        [name, guildId]
      );

      if (res.rows.length > 0) {
        const exp = res.rows[0];
        const customMessage = exp?.content?.includes('{user}')
          ? exp.content.replace('{user}', userMention)
          : getRandomFlavor(name, userMention) || `💥 ${userMention} is experiencing **"${name}"** energy today!`;

        if (exp?.type === 'image') {
          const file = new AttachmentBuilder(exp.content);
          return await message.reply({ content: customMessage, files: [file] });
        }

        return message.reply({ content: customMessage });
      }

      if (flavorMap[name]) {
        const builtMessage = getRandomFlavor(name, userMention);
        return message.reply({ content: builtMessage });
      }

      return message.reply({ content: '❌ Unknown expression. Use valid keywords or saved expressions.' });
    } catch (err) {
      console.error('❌ Error handling !exp:', err);
      return message.reply({ content: '⚠️ Internal error occurred while processing this command.' });
    }
  });
};
