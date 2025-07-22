const { EmbedBuilder } = require('discord.js');

module.exports = (client) => {
  client.on('guildMemberAdd', async member => {
    const pg = client.pg;
    const guildId = member.guild.id;

    try {
      const res = await pg.query(`
        SELECT * FROM welcome_settings
        WHERE guild_id = $1 AND enabled = true
      `, [guildId]);

      if (res.rowCount === 0) return;

      const row = res.rows[0];
      const channel = await member.guild.channels.fetch(row.welcome_channel_id).catch(() => null);
      if (!channel) return;

      const embed = new EmbedBuilder()
        .setTitle(`👋 Welcome to ${member.guild.name}`)
        .setDescription(`Hey ${member}, welcome to the guild! 🎉`)
        .setThumbnail(member.user.displayAvatarURL())
        .setColor('#00FF99')
        .setFooter({ text: 'Make yourself at home, legend.' })
        .setTimestamp();

      await channel.send({ content: `🎉 Welcome <@${member.id}>!`, embeds: [embed] });
    } catch (err) {
      console.error(`❌ Welcome error for guild ${guildId}:`, err);
    }
  });
};
