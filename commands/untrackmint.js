const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmintplus')
    .setDescription('Stop tracking a mint/sale contract on a specific chain')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Contract name to stop tracking')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('chain')
        .setDescription('Which chain to stop tracking?')
        .setRequired(true)
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' },
          { name: 'ApeChain', value: 'ape' }
        )
    ),

  async autocomplete(interaction) {
    const pg = interaction.client.pg;
    const focused = interaction.options.getFocused();
    const chain = interaction.options.getString('chain');
    const guildId = interaction.guild?.id;

    if (!guildId) return interaction.respond([]);

    try {
      const values = [guildId];
      let query = `SELECT name FROM contract_watchlist WHERE guild_id = $1`;

      if (chain) {
        values.push(chain);
        query += ` AND chain = $2`;
      }

      const res = await pg.query(query, values);
      const names = res.rows.map(r => r.name);
      const filtered = names
        .filter(n => n.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25);

      await interaction.respond(filtered.map(name => ({ name, value: name })));
    } catch (err) {
      console.warn('❌ Autocomplete error in untrackmintplus:', err);
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const pg = interaction.client.pg;
    const { member, options, guild } = interaction;

    const name = options.getString('name');
    const chain = options.getString('chain');
    const guildId = guild?.id;

    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await pg.query(
        `DELETE FROM contract_watchlist WHERE name = $1 AND chain = $2 AND guild_id = $3 RETURNING *`,
        [name, chain, guildId]
      );

      if (!result.rowCount) {
        return interaction.editReply(`❌ No contract found named **${name}** on \`${chain}\`.`);
      }

      return interaction.editReply(`🛑 Stopped tracking **${name}** on \`${chain}\`.`);
    } catch (err) {
      console.error('❌ Error in /untrackmintplus:', err);
      return interaction.editReply('⚠️ Failed to execute `/untrackmintplus`.');
    }
  }
};

