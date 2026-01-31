const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

/**
 * Resolve bot owner IDs safely (supports:
 * - ENV: BOT_OWNER_ID / BOT_OWNER_IDS
 * - App owner fetch: user-owned OR team-owned applications
 * Cached on client.__botOwnerIds
 */
async function getBotOwnerIds(client) {
  try {
    if (client.__botOwnerIds && Array.isArray(client.__botOwnerIds)) return client.__botOwnerIds;

    // 1) ENV owners (fast path)
    const envRaw = [
      process.env.BOT_OWNER_IDS || '',
      process.env.BOT_OWNER_ID || ''
    ].filter(Boolean).join(',');

    const envIds = envRaw
      .split(',')
      .map(s => String(s || '').trim())
      .filter(Boolean);

    // 2) Try to fetch application owner/team
    let appOwnerIds = [];
    try {
      const app = await client.application.fetch();
      const owner = app?.owner;

      // Team-owned application
      if (owner && owner.members && typeof owner.members.map === 'function') {
        appOwnerIds = owner.members.map(m => m?.id).filter(Boolean);
      }
      // User-owned application
      else if (owner?.id) {
        appOwnerIds = [owner.id];
      }
    } catch (e) {
      // ignore fetch errors; rely on env only
    }

    const merged = Array.from(new Set([...envIds, ...appOwnerIds]));
    client.__botOwnerIds = merged;
    return merged;
  } catch (e) {
    return [];
  }
}

function isAdmin(interaction) {
  // memberPermissions is safest in discord.js v14
  const perms = interaction.memberPermissions || interaction.member?.permissions;
  return Boolean(perms?.has?.(PermissionsBitField.Flags.Administrator));
}

async function isBotOwner(interaction) {
  const ownerIds = await getBotOwnerIds(interaction.client);
  return ownerIds.includes(interaction.user.id);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackchannel')
    .setDescription('Remove this channel from a contract’s alerts')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Select contract name')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name');
    const currentChannelId = interaction.channel.id;

    const admin = isAdmin(interaction);
    const owner = await isBotOwner(interaction);

    if (!admin && !owner) {
      return interaction.reply({
        content: '🚫 Admins or bot owner only.',
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);

      if (!result.rows.length) {
        return interaction.editReply(`❌ Contract **${name}** not found.`);
      }

      const existingChannels = result.rows[0].channel_ids || [];
      const updatedChannels = existingChannels.filter(id => id !== currentChannelId);

      await pg.query(
        `UPDATE contract_watchlist SET channel_ids = $1 WHERE name = $2`,
        [updatedChannels, name]
      );

      if (updatedChannels.length) {
        const mentions = updatedChannels.map(id => `<#${id}>`).join(', ');
        return interaction.editReply(
          `✅ Removed <#${currentChannelId}> from **${name}** alerts.\n📡 Still tracking in: ${mentions}`
        );
      } else {
        return interaction.editReply(
          `✅ Removed <#${currentChannelId}> from **${name}** alerts.\n⚠️ No channels are tracking this anymore.`
        );
      }
    } catch (err) {
      console.error('❌ Error in /untrackchannel:', err);
      return interaction.editReply('⚠️ Something went wrong.');
    }
  },

  async autocomplete(interaction) {
    try {
      // Optional: also restrict autocomplete to Admin/Owner to avoid leaking contract names
      const admin = isAdmin(interaction);
      const owner = await isBotOwner(interaction);
      if (!admin && !owner) {
        return interaction.respond([]);
      }

      const pg = interaction.client.pg;
      const focused = interaction.options.getFocused();

      const res = await pg.query(`SELECT name FROM contract_watchlist`);
      const contracts = res.rows.map(r => r.name);

      const filtered = contracts
        .filter(n => n.toLowerCase().includes(String(focused || '').toLowerCase()))
        .slice(0, 25);

      console.log('📊 Sending autocomplete choices:', filtered);

      await interaction.respond(
        filtered.map(name => ({ name, value: name }))
      );
    } catch (err) {
      console.error('❌ Autocomplete error in /untrackchannel:', err);
      try {
        await interaction.respond([]);
      } catch (e) {
        // ignore double-respond errors
      }
    }
  }
};

