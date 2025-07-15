// ✅ listeners/fftrigger.js — Clean working version, no unnecessary requires
module.exports = (client) => {
  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const guildId = message.guild.id;
    const botOwnerId = process.env.BOT_OWNER_ID;

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

      if (!result.rows.length && message.author.id !== botOwnerId) {
        return message.reply('❌ Flex project not found. Use `/addflex` first.').catch(() => {});
      }

      const { address, name } = result.rows[0] || {};
      const randomTokenId = Math.floor(Math.random() * 500) + 1;

      const flexFloppyCommand = client.commands.get('flexfloppy');
      if (flexFloppyCommand) {
        await flexFloppyCommand.executeFakeInteraction(client, message, {
          name: name || projectName,
          tokenid: randomTokenId,
          guildId,
          authorId: message.author.id
        });
      }

    } catch (err) {
      console.error('❌ ff-trigger-command error:', err);
    }
  });
};


