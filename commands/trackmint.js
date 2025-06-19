const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const { TOKEN_NAME_TO_ADDRESS } = require('../constants') || {};
const { trackAllContracts } = require('../services/mintProcessor');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trackmintplus')
    .setDescription('Track a contract for minting and/or sales on any supported chain')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Contract name').setRequired(true))
    .addStringOption(opt =>
      opt.setName('address').setDescription('Contract address').setRequired(true))
    .addStringOption(opt =>
      opt.setName('chain')
        .setDescription('Which chain? base, eth, ape')
        .setRequired(true)
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' },
          { name: 'ApeChain', value: 'ape' }
        ))
    .addNumberOption(opt =>
      opt.setName('price').setDescription('Mint price (optional)').setRequired(false))
    .addStringOption(opt =>
      opt.setName('token').setDescription('Mint token (symbol or address)').setRequired(false)),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const { options, channel, member } = interaction;

    const name = options.getString('name');
    const address = options.getString('address');
    const chain = options.getString('chain') || 'base';
    const mint_price = options.getNumber('price') ?? null;
    const tokenSymbol = options.getString('token') || 'ETH';
    const resolvedSymbol = tokenSymbol.toUpperCase();
    const tokenAddr = TOKEN_NAME_TO_ADDRESS?.[resolvedSymbol] || tokenSymbol;
    const currentChannel = channel.id;

    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    // ✅ Auto-migrate SQL columns if needed
    try {
      await pg.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contract_watchlist' AND column_name = 'chain') THEN
            ALTER TABLE contract_watchlist ADD COLUMN chain TEXT DEFAULT 'base';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contract_watchlist' AND column_name = 'channel_ids') THEN
            ALTER TABLE contract_watchlist ADD COLUMN channel_ids TEXT[];
          END IF;
        END
        $$;
      `);
    } catch (migrateErr) {
      console.warn('⚠️ Migration failed:', migrateErr.message);
    }

    try {
      const res = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1 AND chain = $2`, [name, chain]);

      if (res.rows.length > 0) {
        const existing = res.rows[0].channel_ids || [];
        const channel_ids = [...new Set([...existing, currentChannel])];

        await pg.query(
          `UPDATE contract_watchlist SET channel_ids = $1 WHERE name = $2 AND chain = $3`,
          [channel_ids, name, chain]
        );

        const updated = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1 AND chain = $2`, [name, chain]);
        await trackAllContracts(interaction.client, updated.rows[0]);

        return interaction.editReply(`✅ Updated tracking for **${name}** on \`${chain}\` and added this channel.`);
      }

      const channel_ids = [currentChannel];

      await pg.query(
        `INSERT INTO contract_watchlist (name, address, chain, mint_price, mint_token, mint_token_symbol, channel_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [name, address, chain, mint_price, tokenAddr, resolvedSymbol, channel_ids]
      );

      const newRow = {
        name,
        address,
        chain,
        mint_price,
        mint_token: tokenAddr,
        mint_token_symbol: resolvedSymbol,
        channel_ids
      };

      await trackAllContracts(interaction.client, newRow);

      return interaction.editReply(`✅ Now tracking **${name}** on \`${chain}\` for ${mint_price ? 'minting and sales' : 'sales only'}${mint_price ? ` using token \`${resolvedSymbol}\`` : ''}.`);
    } catch (err) {
      console.error('❌ Error in /trackmintplus:', err);
      return interaction.editReply('⚠️ Something went wrong while executing `/trackmintplus`.');
    }
  }
};

