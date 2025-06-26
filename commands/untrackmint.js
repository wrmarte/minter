const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmintplus')
    .setDescription('🛑 Stop tracking a mint/sale contract on a specific chain')
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
      let query = `SELECT name, address, chain, channel_ids FROM contract_watchlist WHERE 1=1`;

      query += ` AND (channel_ids IS NOT NULL AND channel_ids <> '')`;
      query += ` AND EXISTS (
        SELECT 1 FROM unnest(string_to_array(channel_ids, ',')) AS cid
        WHERE cid ~ '^[0-9]+'
      )`;

      if (chain) {
        query += ` AND chain = $${values.length + 1}`;
        values.push(chain);
      }

      const res = await pg.query(query, values);
      const results = res.rows;

      const filtered = results
        .filter(r => r.name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25)
        .map(r => {
          const emoji = r.chain === 'base' ? '🟦' : r.chain === 'eth' ? '🟧' : '🐵';
          const shortAddr = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
          const channels = Array.isArray(r.channel_ids)
            ? r.channel_ids
            : (r.channel_ids || '').toString().split(',').filter(Boolean);
          const displayChannels = channels.length === 1
            ? `<#${channels[0]}>`
            : `${channels.length} channels`;

          return {
            name: `${emoji} ${r.name} • ${shortAddr} • ${displayChannels}`,
            value: r.name
          };
        });

      await interaction.respond(filtered);
    } catch (err) {
      console.warn('❌ Autocomplete error in /untrackmintplus:', err);
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
        `DELETE FROM contract_watchlist WHERE name = $1 AND chain = $2 AND channel_ids IS NOT NULL AND channel_ids <> '' RETURNING *`,
        [name, chain]
      );

      if (!result.rowCount) {
        return interaction.editReply(`❌ No tracked contract named **${name}** on \`${chain}\`.`);
      }

      return interaction.editReply(`🛑 Successfully untracked **${name}** on \`${chain}\`.`);
    } catch (err) {
      console.error('❌ Error in /untrackmintplus:', err);
      return interaction.editReply('⚠️ Failed to execute `/untrackmintplus`.');
    }
  }
};


