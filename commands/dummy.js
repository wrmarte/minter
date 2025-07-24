const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dummy')
    .setDescription('Display a saved dummy info embed')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('The name of the dummy info to fetch')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addUserOption(opt =>
      opt.setName('target')
        .setDescription('Optionally tag a user in the dummy response')
        .setRequired(false)
    ),

  async execute(interaction) {
    const name = interaction.options.getString('name');
    const target = interaction.options.getUser('target');
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    try {
      const res = await pg.query(
        'SELECT content FROM dummy_info WHERE name = $1 AND guild_id = $2',
        [name, guildId]
      );

      if (res.rowCount === 0) {
        return await interaction.reply({
          content: `❌ No dummy info found with name "**${name}**"`,
          ephemeral: true
        });
      }

      const rawContent = res.rows[0].content;

      // 🔗 Convert raw links to clickable markdown links
      let linkCount = 0;
      const content = rawContent.replace(
        /(https?:\/\/[^\s]+)/gi,
        (url) => {
          linkCount++;
          return `🔗 [Link ${linkCount}](${url})`;
        }
      );

      // 🎨 Embed styling
      const colors = ['#FF8C00', '#7289DA', '#00CED1', '#ADFF2F', '#FF69B4', '#FFD700', '#4B0082'];
      const embed = new EmbedBuilder()
        .setTitle(`📘 ${name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}`)
        .setDescription(content)
        .setColor(colors[Math.floor(Math.random() * colors.length)])
        .setFooter({ text: 'Muscle MB — Dummy Info' })
        .setTimestamp();

      // 🧼 Just acknowledge and delete trigger
      await interaction.deferReply({ ephemeral: true });
      await interaction.deleteReply();

      // 📢 Bot sends clean embed to channel
      await interaction.channel.send({
        content: target ? `📣 ${target}` : null,
        embeds: [embed]
      });

    } catch (err) {
      console.error('❌ Dummy fetch error:', err);
      if (!interaction.replied)
        await interaction.reply({ content: '❌ Failed to fetch dummy info.', ephemeral: true });
    }
  },

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const pg = interaction.client.pg;
    const guildId = interaction.guild.id;

    try {
      const res = await pg.query(
        'SELECT name FROM dummy_info WHERE guild_id = $1',
        [guildId]
      );

      const choices = res.rows
        .map(r => r.name)
        .filter(name => name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25);

      await interaction.respond(
        choices.map(name => ({ name, value: name }))
      );
    } catch (err) {
      console.error('❌ Dummy autocomplete error:', err);
      await interaction.respond([]);
    }
  }
};



