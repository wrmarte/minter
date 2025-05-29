const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addexp')
    .setDescription('Add a new expression (image or text)')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Unique name of the expression (e.g., "rich")')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of expression')
        .setRequired(true)
        .addChoices(
          { name: 'Image', value: 'image' },
          { name: 'Text', value: 'text' }
        )
    )
    .addStringOption(option =>
      option.setName('content')
        .setDescription('Image URL or message (e.g. "💸 {user} is rich!")')
        .setRequired(true)
    ),

  async execute(interaction, { pg }) {
    const ownerId = process.env.BOT_OWNER_ID;
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: '❌ Only the bot owner can use this.',
        flags: 64
      });
    }

    const name = interaction.options.getString('name').toLowerCase();
    const type = interaction.options.getString('type');
    const content = interaction.options.getString('content');
    const guildId = interaction.guild?.id ?? 'global';

    try {
      // ✅ Create table if not exists
      await pg.query(`
        CREATE TABLE IF NOT EXISTS expressions (
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          guild_id TEXT
        );
      `);

      // ✅ Ensure all existing NULL guild_id are updated to 'global'
      await pg.query(`UPDATE expressions SET guild_id = 'global' WHERE guild_id IS NULL;`);

      // ✅ Add primary key safely
      await pg.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'expressions_name_guild_id_pk'
          ) THEN
            ALTER TABLE expressions
              DROP CONSTRAINT IF EXISTS expressions_pkey,
              ADD CONSTRAINT expressions_name_guild_id_pk PRIMARY KEY (name, guild_id);
          END IF;
        END$$;
      `);

      // ✅ Upsert
      await pg.query(`
        INSERT INTO expressions (name, type, content, guild_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name, guild_id)
        DO UPDATE SET type = EXCLUDED.type, content = EXCLUDED.content
      `, [name, type, content, guildId]);

      return interaction.reply({
        content: `✅ Expression \`${name}\` saved as \`${type}\` for \`${guildId}\`.`,
        flags: 64
      });

    } catch (err) {
      console.error('❌ Failed to insert expression:', err);
      return interaction.reply({
        content: `⚠️ Error: \`${err.code}\` while saving expression.`,
        flags: 64
      });
    }
  }
};









