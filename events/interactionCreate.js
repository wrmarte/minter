// interactionCreate.js FULL PATCHED + LABELS + UNTRACKMINTPLUS BUTTON ROUTER + LURKER MODAL/BUTTON ROUTER + ✅ MBMEM MODAL ROUTER
const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { flavorMap } = require('../utils/flavorMap');
const { Contract } = require('ethers');
const fetch = require('node-fetch');
const { getProvider } = require('../services/provider');
const OpenAI = require('openai');

/* ======================================================
   LABEL/DEBUG HELPERS
====================================================== */
const IC_LABEL = '[IC]';
const IC_DEBUG = String(process.env.IC_DEBUG || process.env.LURKER_DEBUG || '0').trim() === '1';
function log(...args) { console.log(IC_LABEL, ...args); }
function warn(...args) { console.warn(IC_LABEL, ...args); }
function errlog(...args) { console.error(IC_LABEL, ...args); }

/* ✅ NEW: LURKER interaction handlers (safe require) */
let handleLurkerButton = null;
try {
  const mod = require('../services/lurker/lurkerInteractions');
  if (mod && typeof mod.handleLurkerButton === 'function') {
    handleLurkerButton = mod.handleLurkerButton;
    if (IC_DEBUG) log('[LURKER] lurkerInteractions loaded ✅');
  } else {
    warn('⚠️ [LURKER] interactions loaded but missing handleLurkerButton()');
  }
} catch (e) {
  warn('⚠️ [LURKER] interactions module not found (safe): ../services/lurker/lurkerInteractions');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Legacy MuscleMB text trigger gate (default OFF — modular listener should own this)
const MUSCLEMB_LEGACY_TEXT_TRIGGER = String(process.env.MUSCLEMB_LEGACY_TEXT_TRIGGER || '0').trim() === '1';
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

module.exports = (client, pg) => {
  const guildNameCache = new Map();

  // ✅ Ensure client.pg exists (many services rely on this)
  try {
    if (!client.pg && pg?.query) client.pg = pg;
  } catch {}

  // INTERACTION HANDLER
  client.on('interactionCreate', async interaction => {
    /* ======================================================
       ✅ LURKER: MODAL SUBMIT ROUTER (must be early)
       - Calls commands/lurker.js handleModal(interaction, client)
       ====================================================== */
    if (interaction.isModalSubmit() && String(interaction.customId || '') === 'lurker_modal_set') {
      if (IC_DEBUG) log('[LURKER] modal submit received');
      try {
        const cmd = interaction.client.commands.get('lurker');
        if (cmd && typeof cmd.handleModal === 'function') {
          const handled = await cmd.handleModal(interaction, client);
          if (handled) return;
        }
        // If not handled, still stop here to prevent fallthrough weirdness
        await interaction.reply({ content: '⚠️ Lurker modal handler not available.', ephemeral: true }).catch(() => null);
      } catch (error) {
        errlog('❌ [LURKER] modal error:', error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply('⚠️ Failed to process Lurker modal.');
          } else {
            await interaction.reply({ content: '⚠️ Failed to process Lurker modal.', ephemeral: true });
          }
        } catch {}
      }
      return;
    }

    /* ======================================================
       ✅ MBMEM: MODAL SUBMIT ROUTER (must be early)
       - Handles customId like: mbmem_modal:<guildId>:<targetId>:<actorId>:<stamp>
       - Prefer command registry (client.commands), fallback to require
       ====================================================== */
    if (interaction.isModalSubmit() && String(interaction.customId || '').startsWith('mbmem_modal:')) {
      const cid = String(interaction.customId || '');
      if (IC_DEBUG) log('[MBMEM] modal submit received:', cid);

      // ✅ ACK FAST (prevents "Interaction failed")
      await interaction.deferReply({ ephemeral: true }).catch(() => null);

      try {
        const parts = cid.split(':'); // mbmem_modal:guild:target:actor:stamp
        const guildId = parts[1] || '';
        const targetId = parts[2] || '';
        const actorId = parts[3] || '';

        if (!guildId || !targetId || !actorId) {
          await interaction.editReply('⚠️ Invalid MBMEM modal payload. Re-open `/mbmem panel`.').catch(() => null);
          return;
        }

        if (String(interaction.guildId) !== String(guildId)) {
          await interaction.editReply('⚠️ Guild mismatch. Re-open `/mbmem panel`.').catch(() => null);
          return;
        }

        if (String(interaction.user?.id) !== String(actorId)) {
          await interaction.editReply(`⛔ Only <@${actorId}> can submit this modal.`).catch(() => null);
          return;
        }

        const ownerId = String(process.env.BOT_OWNER_ID || '').trim();
        const isOwner = ownerId && String(interaction.user.id) === ownerId;
        const isAdmin = Boolean(interaction.memberPermissions?.has?.(PermissionsBitField.Flags.Administrator));
        const managingSelf = String(targetId) === String(interaction.user.id);

        if (!managingSelf && !(isOwner || isAdmin)) {
          await interaction.editReply('⛔ Admin only to edit memory for other users.').catch(() => null);
          return;
        }

        // ✅ Ensure DB is reachable (and client.pg set)
        const pgx = client?.pg || pg;
        if (!pgx?.query) {
          await interaction.editReply('⚠️ DB not ready. Try again in a moment.').catch(() => null);
          return;
        }
        try { if (!client.pg && pgx?.query) client.pg = pgx; } catch {}

        const factsBlob = interaction.fields.getTextInputValue('facts') || '';
        const tagsBlobRaw = interaction.fields.getTextInputValue('tags') || '';
        const noteTextRaw = interaction.fields.getTextInputValue('note') || '';

        // ✅ Prefer the registered command module (no require cache surprises)
        let mbmem = interaction.client.commands.get('mbmem');

        // fallback to require if command registry missing for any reason
        if (!mbmem) {
          try { mbmem = require('../commands/mbmem'); } catch { mbmem = null; }
        }

        // If command exposes handleModalSubmit, let it run it (cleanest)
        if (mbmem && typeof mbmem.handleModalSubmit === 'function') {
          const handled = await mbmem.handleModalSubmit(interaction, client);
          if (handled) return; // it replied/edited already
        }

        // Otherwise fallback to applyEdits
        if (!mbmem || typeof mbmem.applyEdits !== 'function') {
          await interaction.editReply('⚠️ MBMEM handler not available (applyEdits missing).').catch(() => null);
          return;
        }

        const res = await mbmem.applyEdits({
          client,
          guildId,
          targetId,
          actingId: actorId,
          factsBlob,
          tagsBlobRaw,
          noteTextRaw,
        });

        await interaction.editReply(
          res.changed
            ? `✅ Saved for <@${targetId}> — ${res.summary}${res.failCount ? `\n⚠️ Some items failed: ${res.failCount}/${res.okCount + res.failCount}` : ''}`
            : '⚠️ No changes detected. (Fill at least one field.)'
        ).catch(() => null);

      } catch (error) {
        errlog('❌ [MBMEM] modal error:', error);
        try {
          await interaction.editReply('⚠️ Failed to process MBMEM modal.').catch(() => null);
        } catch {}
      }

      return; // ✅ prevent fallthrough
    }

    // BLOCK 1: Check if autocomplete command exists first (modular check)
    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (command && typeof command.autocomplete === 'function') {
        try {
          if (command.autocomplete.length > 1) {
            await command.autocomplete(interaction, client.pg);
          } else {
            await command.autocomplete(interaction);
          }
        } catch (error) {
          errlog(`❌ Autocomplete error for ${interaction.commandName}:`, error);
        }
        return;
      }

      // BLOCK 2: Fallback autocomplete logic
      const { commandName, options } = interaction;
      const focused = options.getFocused(true);
      const guildId = interaction.guild?.id;
      const userId = interaction.user.id;
      const ownerId = process.env.BOT_OWNER_ID;
      const isOwner = userId === ownerId;

      const safeRespond = async (choices) => {
        try {
          if (!interaction.responded) await interaction.respond(choices);
        } catch (error) {
          if (error.code === 10062) warn('⚠️ Autocomplete expired');
          else if (error.code === 40060) warn('⚠️ Already acknowledged');
          else errlog('❌ Autocomplete respond error:', error);
        }
      };

      try {
        const subcommand = interaction.options.getSubcommand(false);

        // FLEX AUTOCOMPLETE BLOCK
        if (commandName === 'flex') {
          if (subcommand === 'duo' && focused.name === 'name') {
            const res = await pg.query(`SELECT name FROM flex_duo WHERE guild_id = $1`, [guildId]);
            const choices = res.rows
              .map(r => r.name)
              .filter(Boolean)
              .filter(n => n.toLowerCase().includes(focused.value.toLowerCase()))
              .slice(0, 25)
              .map(name => ({ name, value: name }));
            return await safeRespond(choices);
          }

          if (['random', 'card', 'plus'].includes(subcommand) && focused.name === 'name') {
            const res = await pg.query(`SELECT name FROM flex_projects WHERE guild_id = $1`, [guildId]);
            const choices = res.rows
              .map(r => r.name)
              .filter(Boolean)
              .filter(n => n.toLowerCase().includes(focused.value.toLowerCase()))
              .slice(0, 25)
              .map(name => ({ name, value: name }));
            return await safeRespond(choices);
          }

          if (subcommand === 'random' && focused.name === 'tokenid') {
            const nameOpt = options.get('name')?.value;
            if (!nameOpt) return;
            const res = await pg.query(`SELECT * FROM flex_projects WHERE guild_id = $1 AND name = $2`, [guildId, nameOpt.toLowerCase()]);
            if (!res.rows.length) return;
            const { address, network } = res.rows[0];
            const chain = (network || 'base').toLowerCase();
            let tokenIds = [];

            if (chain === 'eth') {
              try {
                const resv = await fetch(`https://api.reservoir.tools/tokens/v6?collection=${address}&limit=100&sortBy=floorAskPrice`, { headers: { 'x-api-key': process.env.RESERVOIR_API_KEY } });
                const data = await resv.json();
                tokenIds = data?.tokens?.map(t => t.token?.tokenId).filter(Boolean) || [];
              } catch { tokenIds = []; }
            } else {
              try {
                const provider = getProvider(chain);
                const contract = new Contract(address, ['function totalSupply() view returns (uint256)'], provider);
                const total = await contract.totalSupply();
                const totalNum = parseInt(total);
                tokenIds = Array.from({ length: Math.min(100, totalNum) }, (_, i) => (i + 1).toString());
              } catch { tokenIds = []; }
            }

            const filtered = tokenIds
              .filter(id => id.includes(focused.value))
              .slice(0, 25)
              .map(id => ({ name: `#${id}`, value: parseInt(id) }));
            return await safeRespond(filtered);
          }
        }

        // FLEXDEV AUTOCOMPLETE BLOCK
        if (commandName === 'flexdev' && focused.name === 'name') {
          const res = await pg.query(`SELECT name FROM flex_projects WHERE guild_id = $1`, [guildId]);
          const choices = res.rows
            .map(r => r.name)
            .filter(Boolean)
            .filter(n => n.toLowerCase().includes(focused.value.toLowerCase()))
            .slice(0, 25)
            .map(name => ({ name, value: name }));
          return await safeRespond(choices);
        }

        // EXP AUTOCOMPLETE BLOCK
        if (commandName === 'exp' && focused.name === 'name') {
          const builtInChoices = Object.keys(flavorMap).map(name => ({ name: `🔥 ${name} (Built-in)`, value: name }));
          let query, params;
          if (isOwner) {
            query = `SELECT DISTINCT name, guild_id FROM expressions`; params = [];
          } else {
            query = `SELECT DISTINCT name, guild_id FROM expressions WHERE guild_id = $1 OR guild_id IS NULL`; params = [guildId];
          }
          const res = await pg.query(query, params);
          const thisServer = [], global = [], otherServers = [];
          for (const row of res.rows) {
            if (!row.name) continue;
            if (row.guild_id === null) global.push({ name: `🌐 ${row.name} (Global)`, value: row.name });
            else if (row.guild_id === guildId) thisServer.push({ name: `🏠 ${row.name} (This Server)`, value: row.name });
            else {
              let guildName = guildNameCache.get(row.guild_id);
              if (!guildName) {
                const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
                guildName = guild?.name ?? 'Other Server';
                guildNameCache.set(row.guild_id, guildName);
              }
              otherServers.push({ name: `🛡️ ${row.name} (${guildName})`, value: row.name });
            }
          }
          const combined = [...builtInChoices, ...thisServer, ...global, ...otherServers];
          const filtered = combined
            .filter(c => c.name.toLowerCase().includes(focused.value.toLowerCase()))
            .slice(0, 25);
          return await safeRespond(filtered);
        }

        // UNTRACKMINTPLUS AUTOCOMPLETE BLOCK (kept for compatibility; command now uses buttons)
        if (commandName === 'untrackmintplus' && focused.name === 'contract') {
          const res = await pg.query(`SELECT name, address, chain, channel_ids FROM contract_watchlist`);
          const options = [];
          for (const row of res.rows) {
            if (!row.name || !row.name.toLowerCase().includes(focused.value.toLowerCase())) continue;
            const chain = row.chain || 'unknown';
            const emoji = chain === 'base' ? '🟦' : chain === 'eth' ? '🟧' : chain === 'ape' ? '🐵' : '❓';
            const icon = row.name.toLowerCase().includes('ghost') ? '👻'
              : row.name.toLowerCase().includes('brother') ? '👑'
              : row.name.toLowerCase().includes('adrian') ? '💀'
              : row.name.toLowerCase().includes('dz') ? '🎯'
              : row.name.toLowerCase().includes('crypto') ? '🖼️'
              : '📦';
            const channels = Array.isArray(row.channel_ids)
              ? row.channel_ids
              : (row.channel_ids || '').toString().split(',').filter(Boolean);
            let matchedChannel = null;
            for (const cid of channels) {
              const channel = interaction.client.channels.cache.get(cid);
              if (channel?.guild?.id === guildId) {
                matchedChannel = channel;
                break;
              }
            }
            if (!matchedChannel) continue;
            const channelName = `#${matchedChannel.name}`;
            const display = `${icon} ${row.name.padEnd(14)} • ${channelName.padEnd(15)} • ${chain.charAt(0).toUpperCase() + chain.slice(1)} ${emoji}`;
            const value = `${row.name}|${chain}`;
            options.push({ name: display.slice(0, 100), value, _sortChain: chain === 'base' ? 0 : chain === 'eth' ? 1 : 2 });
            if (options.length >= 50) break;
          }
          const sorted = options
            .sort((a, b) => a._sortChain - b._sortChain)
            .slice(0, 25)
            .map(({ name, value }) => ({ name, value }));
          return await safeRespond(sorted);
        }
      } catch (error) {
        errlog('❌ Autocomplete error:', error);
      }
      return;
    }

    // BUTTON HANDLERS

    /* ======================================================
       ✅ LURKER: BUTTON ROUTER (Buy / Ignore)
       ====================================================== */
    if (
      interaction.isButton() &&
      (interaction.customId.startsWith('lurker_buy:') || interaction.customId.startsWith('lurker_ignore:'))
    ) {
      if (IC_DEBUG) log('[LURKER] button:', interaction.customId);
      try {
        if (handleLurkerButton) {
          const handled = await handleLurkerButton(interaction, client);
          if (handled) return;
        }

        const parts = String(interaction.customId).split(':'); // lurker_ignore:ruleId:listingId
        const action = parts[0];
        const ruleId = Number(parts[1]);
        const listingId = parts.slice(2).join(':'); // safe join

        if (!ruleId || !listingId) {
          await interaction.reply({ content: '⚠️ Invalid Lurker button payload.', ephemeral: true }).catch(() => null);
          return;
        }

        const pgx = client.pg;
        if (!pgx?.query) {
          await interaction.reply({ content: '⚠️ DB not ready for Lurker.', ephemeral: true }).catch(() => null);
          return;
        }

        await pgx.query(
          `INSERT INTO lurker_seen(rule_id, listing_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [ruleId, listingId]
        );

        if (action === 'lurker_ignore') {
          await interaction.reply({ content: `🟢 Ignored listing (rule #${ruleId}).`, ephemeral: true }).catch(() => null);
        } else {
          await interaction.reply({
            content: `🟢 Buy clicked (rule #${ruleId}).\nFor now: sim-only — execution wiring comes next.`,
            ephemeral: true
          }).catch(() => null);
        }
      } catch (error) {
        errlog('❌ Button handler error (lurker):', error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply('⚠️ Failed to process Lurker button.');
          } else {
            await interaction.reply({ content: '⚠️ Failed to process Lurker button.', ephemeral: true });
          }
        } catch {}
      }
      return;
    }

    // ✅ UntrackMintPlus button router
    if (interaction.isButton() && interaction.customId.startsWith('untrackmintplus:')) {
      if (IC_DEBUG) log('[UNTRACKMINTPLUS] button:', interaction.customId);
      try {
        const mod = interaction.client.commands.get('untrackmintplus');
        if (mod && typeof mod.handleButton === 'function') {
          await mod.handleButton(interaction);
        } else {
          await interaction.reply({ content: '⚠️ Button handler not available.', ephemeral: true });
        }
      } catch (error) {
        errlog('❌ Button handler error (untrackmintplus):', error);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply('⚠️ Failed to process button.');
          } else {
            await interaction.reply({ content: '⚠️ Failed to process button.', ephemeral: true });
          }
        } catch {}
      }
      return;
    }

    if (interaction.isButton() && interaction.customId === 'test_welcome_button') {
      const pgx = interaction.client.pg;
      const guild = interaction.guild;
      const member = interaction.member;

      try {
        const res = await pgx.query(
          'SELECT * FROM welcome_settings WHERE guild_id = $1 AND enabled = true',
          [guild.id]
        );

        if (res.rowCount === 0) return await interaction.reply({ content: '❌ Welcome is not enabled.', ephemeral: true });

        const row = res.rows[0];
        const channel = await guild.channels.fetch(row.welcome_channel_id).catch(() => null);
        if (!channel) return await interaction.reply({ content: '❌ Channel not found.', ephemeral: true });

        const embed = new EmbedBuilder()
          .setTitle(`👋 Welcome to ${guild.name}`)
          .setDescription(`Hey ${member}, welcome to the guild! 🎉`)
          .setThumbnail(member.user.displayAvatarURL())
          .setColor('#00FF99')
          .setFooter({ text: 'Make yourself at home, legend.' })
          .setTimestamp();

        await channel.send({ content: `🎉 Welcome <@${member.id}> (test)`, embeds: [embed] });

        await interaction.reply({ content: `✅ Test welcome sent to <#${channel.id}>`, ephemeral: true });
      } catch (error) {
        errlog('❌ Error sending test welcome:', error);
        await interaction.reply({ content: '❌ Failed to send test welcome.', ephemeral: true });
      }
      return;
    }

    // CHAT INPUT COMMAND HANDLER
    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      if (interaction.commandName === 'lurker') {
        if (IC_DEBUG) log('[LURKER] slash command');
        await command.execute(interaction, client);
        return;
      }

      const needsPg = command.execute.length > 1;
      if (needsPg) await command.execute(interaction, { pg });
      else await command.execute(interaction);
    } catch (error) {
      errlog(`❌ Error executing /${interaction.commandName}:`, error);
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: '⚠️ Something went wrong.' });
        else await interaction.reply({ content: '⚠️ Error executing command.', ephemeral: true });
      } catch (fallbackError) {
        errlog('⚠️ Failed to send error message:', fallbackError.message);
      }
    }
  });

  // ======================================================
  // ✅ LEGACY MUSCLEMB TEXT TRIGGER (OPTIONAL)
  // ======================================================
  client.on('messageCreate', async (message) => {
    if (!MUSCLEMB_LEGACY_TEXT_TRIGGER) return;

    if (message.author.bot) return;
    if (!message.guild) return;

    const content = (message.content || '').trim();
    const lowered = content.toLowerCase();
    if (!lowered.startsWith('musclemb ')) return;

    const userMsg = content.slice('musclemb'.length).trim();
    if (!userMsg) {
      try { await message.reply({ content: '💬 Say something for MuscleMB to chew on, bro.', allowedMentions: { parse: [] } }); } catch {}
      return;
    }

    try { await message.channel.sendTyping(); } catch {}

    try {
      const apiKey = (process.env.OPENAI_API_KEY || '').trim();
      if (!apiKey) {
        await message.reply({ content: '⚠️ OPENAI_API_KEY missing. Legacy trigger disabled unless key is set.', allowedMentions: { parse: [] } });
        return;
      }

      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: 'You are MuscleMB — savage crypto bro style bot.' },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.95,
      });

      const aiReply = completion?.choices?.[0]?.message?.content || '';
      const safe = String(aiReply).slice(0, 1800).trim();

      await message.reply({ content: safe || '⚠️ MuscleMB returned no text.', allowedMentions: { parse: [] } });
    } catch (error) {
      errlog('❌ MuscleMB (legacy text trigger) error:', error?.message || String(error));
      try { await message.reply({ content: '⚠️ MuscleMB blacked out. Try again later.', allowedMentions: { parse: [] } }); } catch {}
    }
  });
};
