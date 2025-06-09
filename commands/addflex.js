const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addflex')
    .setDescription('Register a new NFT project to flex from')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Project name').setRequired(true))
    .addStringOption(opt =>
      opt.setName('address').setDescription('Contract address').setRequired(true))
    .addStringOption(opt =>
      opt.setName('network')
        .setDescription('Network: Base, Ethereum or ApeChain')
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' },
          { name: 'ApeChain', value: 'ape' }
        )
        .setRequired(true)
    ),

  async execute(interaction) {
    const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
    const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;

    if (!isAdmin && !isOwner) {
      return interaction.reply({ content: '🚫 Admins only. (Bot owner bypass not detected)', ephemeral: true });
    }

    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase().trim();
    const address = interaction.options.getString('address').toLowerCase().trim();
    const network = interaction.options.getString('network');
    const guildId = interaction.guild.id;

    try {
      // ✅ Ensure table exists
      await pg.query(`
        CREATE TABLE IF NOT EXISTS flex_projects (
          guild_id TEXT,
          name TEXT,
          address TEXT,
          network TEXT
        );
      `);

      // ✅ Ensure correct primary key (guild_id + name)
      await pg.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_name = 'flex_projects'
            AND constraint_type = 'PRIMARY KEY'
            AND constraint_name = 'flex_projects_pkey'
          ) THEN
            ALTER TABLE flex_projects DROP CONSTRAINT flex_projects_pkey;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_name = 'flex_projects'
            AND constraint_type = 'PRIMARY KEY'
            AND constraint_name = 'flex_projects_pk'
          ) THEN
            ALTER TABLE flex_projects ADD CONSTRAINT flex_projects_pk PRIMARY KEY (guild_id, name);
          END IF;
        END
        $$;
      `);

      // ✅ Insert or update
      await pg.query(`
        INSERT INTO flex_projects (guild_id, name, address, network)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (guild_id, name) DO UPDATE SET
          address = EXCLUDED.address,
          network = EXCLUDED.network
      `, [guildId, name, address, network]);

      return interaction.reply(`✅ Project **${name}** added for flexing on **${network.toUpperCase()}**.`);
    } catch (err) {
      console.error('❌ Error in /addflex:', err);
      return interaction.reply({
        content: `❌ Error while saving project:\n\`\`\`${err.message || err.toString()}\`\`\``,
        ephemeral: true
      });
    }
  }
};






