const { EmbedBuilder } = require('discord.js');

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const content = message.content.trim().toLowerCase();
    if (content !== 'tt-welcome') return;

    const pg = client.pg;
    const guild = message.guild;
    const member = message.member;

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
        .setTitle(`👋 Welcome to ${guild.name}`)
        .setDescription(`Hey ${member}, welcome to the guild! 🎉`)
        .setThumbnail(member.user.displayAvatarURL())
        .setColor('#00FF99')
        .setFooter({ text: 'Make yourself at home, legend.' })
        .setTimestamp();

      await channel.send({ content: `🎉 Welcome <@${member.id}> (trigger test)`, embeds: [embed] });
    } catch (err) {
      console.error('❌ Welcome trigger error:', err);
    }
  });
};

