const { AttachmentBuilder } = require('discord.js');

// Same data
const expMap = {
  rich: {
    url: 'https://your-railway-domain.com/images/exp-rich.png',
    message: '💸 {user} feeling **rich** today!'
  },
  poor: {
    url: 'https://your-railway-domain.com/images/exp-poor.png',
    message: '💀 {user} is **down bad** today...'
  },
  blessed: {
    url: 'https://your-railway-domain.com/images/exp-blessed.png',
    message: '🌈 {user} is feeling **blessed**!'
  }
};

module.exports = {
  name: 'exp',
  async execute(message, args) {
    const ownerId = process.env.BOT_OWNER_ID;
    if (message.author.id !== ownerId) {
      return message.reply('❌ Only the bot owner can use this command.');
    }

    const name = args[0]?.toLowerCase();
    const exp = expMap[name];

    if (!exp) {
      return message.reply('❌ Unknown experience. Try `!exp rich`, `!exp poor`, or `!exp blessed`.');
    }

    const image = new AttachmentBuilder(exp.url);
    const msg = exp.message.replace('{user}', `<@${message.author.id}>`);

    await message.reply({ content: msg, files: [image] });
  }
};
