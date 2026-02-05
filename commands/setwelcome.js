// commands/setwelcome.js
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const BOT_OWNER_ID = process.env.BOT_OWNER_ID;
const EPHEMERAL_FLAG = 1 << 6; // 64

async function ensureWelcomeSchema(pg) {
  // Minimal schema required by your code paths
  await pg.query(`
    CREATE TABLE IF NOT EXISTS welcome_settings (
      guild_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT false,
      welcome_channel_id TEXT,
      dm_enabled BOOLEAN NOT NULL DEFAULT false,
      delete_after_sec INT,
      message_template TEXT,
      image_url TEXT,
      ping_role_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Ensure columns exist if table was older
  await pg.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='welcome_settings' AND column_name='enabled')
        THEN ALTER TABLE welcome_settings ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT false; END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='welcome_settings' AND column_name='welcome_channel_id')
        THEN ALTER TABLE welcome_settings ADD COLUMN welcome_channel_id TEXT; END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='welcome_settings' AND column_name='dm_enabled')
        THEN ALTER TABLE welcome_settings ADD COLUMN dm_enabled BOOLEAN NOT NULL DEFAULT false; END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='welcome_settings' AND column_name='delete_after_sec')
        THEN ALTER TABLE welcome_settings ADD COLUMN delete_after_sec INT; END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='welcome_settings' AND column_name='message_template')
        THEN ALTER TABLE welcome_settings ADD COLUMN message_template TEXT; END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='welcome_settings' AND column_name='image_url')
        THEN ALTER TABLE welcome_settings ADD COLUMN image_url TEXT; END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='welcome_settings' AND column_name='ping_role_id')
        THEN ALTER TABLE welcome_settings ADD COLUMN ping_role_id TEXT; END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='welcome_settings' AND column_name='created_at')
        THEN ALTER TABLE welcome_settings ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(); END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='welcome_settings' AND column_name='updated_at')
        THEN ALTER TABLE welcome_settings ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(); END IF;
    END $$;
  `);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setwelcome')
    .setDescription('Enable or disable welcome messages in this server')
    .addBooleanOption(option =>
      option.setName('enabled')
        .setDescription('Enable or disable welcome messages')
        .setRequired(true)
    )
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel to send welcome messages')
        .setRequired(true)
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const isOwner = userId === BOT_OWNER_ID;
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    if (!isOwner && !isAdmin) {
      return interaction.reply({
        content: '❌ You must be an admin or the bot owner to use this command.',
        flags: EPHEMERAL_FLAG
      });
    }

    const enabled = interaction.options.getBoolean('enabled');
    const channel = interaction.options.getChannel('channel');
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    if (!pg?.query) {
      return interaction.reply({ content: '❌ DB not ready.', flags: EPHEMERAL_FLAG });
    }

    // Must be text-based
    if (!channel?.isTextBased?.()) {
      return interaction.reply({ content: '❌ Please select a text channel.', flags: EPHEMERAL_FLAG });
    }

    try {
      await ensureWelcomeSchema(pg);

      await pg.query(`
        INSERT INTO welcome_settings (guild_id, enabled, welcome_channel_id, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (guild_id)
        DO UPDATE SET enabled = EXCLUDED.enabled, welcome_channel_id = EXCLUDED.welcome_channel_id, updated_at = NOW()
      `, [guildId, enabled, channel.id]);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('test_welcome_button')
          .setLabel('🔍 Test Welcome')
          .setStyle(ButtonStyle.Primary)
      );

      return interaction.reply({
        content: `✅ Welcome messages have been **${enabled ? 'enabled' : 'disabled'}** in <#${channel.id}>.`,
        components: enabled ? [row] : [],
        flags: EPHEMERAL_FLAG
      });

    } catch (err) {
      console.error(`❌ Failed to set welcome config for guild ${guildId}:`, err);
      return interaction.reply({ content: '❌ Failed to save settings.', flags: EPHEMERAL_FLAG });
    }
  }
};

