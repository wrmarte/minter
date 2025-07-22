const { EmbedBuilder } = require('discord.js');

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const content = message.content.trim().toLowerCase();
    if (content !== 'tt-welcome') return;

    const pg = client.pg;
    const guild = message.guild;
    const member = message.member;

    const colors = ['#00FF99', '#FF69B4', '#FFD700', '#7289DA', '#FF4500', '#00BFFF', '#8A2BE2'];
    const emojis = ['🌀', '🎯', '🔥', '👑', '🛸', '🚀', '💀', '😈', '🍄', '🎮'];
    const welcomeLines = [
      `Welcome to the lair, ${member}! ${emojis[Math.floor(Math.random() * emojis.length)]}`,
      `They made it! ${member} just landed 🛬`,
      `🎉 Fresh meat has arrived: ${member}`,
      `⚔️ ${member} enters the arena. Let the games begin.`,
      `👾 Welcome ${member}, may the gas be ever in your favor.`,
      `💥 ${member} just joined the most degen guild on Discord.`,
      `📦 ${member} dropped in with the alpha. Give 'em love.`,
    ];

    try {
      const res = await pg.query(
        'SELECT * FROM welcome_settings WHERE guild_id = $1 AND enabled = true',
        [guild.id]
      );

      if (res.rowCount === 0) return;

      const row = res.rows[0];
      const channel = await guild.channels.fetch(row.welcome_channel_id).catch(() => null);
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setTitle(`🌊 A New Member Has Surfaced`)
        .setDescription(welcomeLines[Math.floor(Math.random() * welcomeLines.length)])
        .setColor(colors[Math.floor(Math.random() * colors.length)])
        .setThumbnail(member.user.displayAvatarURL())
        // .setImage('https://yourcdn.com/welcome-banner.png') // optional banner
        .setFooter({ text: 'Powered by Muscle MB • No mercy, only vibes.' })
        .setTimestamp();

      await channel.send({ content: `🎉 Welcome <@${member.id}> (trigger test)`, embeds: [embed] });
    } catch (err) {
      console.error('❌ Welcome trigger error:', err);
    }
  });
};
