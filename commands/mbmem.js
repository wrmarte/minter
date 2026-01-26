// commands/mbmem.js
const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');

const ProfileStore = require('../listeners/musclemb/profileStore');
const MemoryStore = require('../listeners/musclemb/memoryStore');

function isOwnerOrAdmin(interaction) {
  try {
    const ownerId = String(process.env.BOT_OWNER_ID || '').trim();
    if (ownerId && interaction.user?.id === ownerId) return true;
    return Boolean(interaction.memberPermissions?.has?.(PermissionsBitField.Flags.Administrator));
  } catch {
    return false;
  }
}

function fmtRelMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `<t:${Math.floor(n / 1000)}:R>`;
}

function fmtRelDate(d) {
  try {
    const t = new Date(d).getTime();
    if (!Number.isFinite(t) || t <= 0) return '—';
    return `<t:${Math.floor(t / 1000)}:R>`;
  } catch {
    return '—';
  }
}

function safeLine(s, max = 160) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function chunk(lines, maxChars = 900) {
  const out = [];
  let buf = '';
  for (const l of lines) {
    const add = (buf ? '\n' : '') + l;
    if ((buf + add).length > maxChars) {
      if (buf) out.push(buf);
      buf = l;
    } else {
      buf += add;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Parse "k=v, k2=v2 | k3=v3" into [{key,value}]
function parseFactsBlob(input, maxPairs = 12) {
  const raw = String(input || '').trim();
  if (!raw) return [];

  // split by newlines, commas, pipes
  const parts = raw
    .split(/[\n,|]+/g)
    .map(s => s.trim())
    .filter(Boolean);

  const pairs = [];
  for (const p of parts) {
    // accept "key=value" or "key: value"
    const m = p.match(/^([^=:\s]{1,64})\s*(=|:)\s*(.+)$/);
    if (!m) continue;
    const key = String(m[1] || '').trim();
    const value = String(m[3] || '').trim();
    if (!key || !value) continue;
    pairs.push({ key, value });
    if (pairs.length >= maxPairs) break;
  }
  return pairs;
}

// Parse "tag1, tag2 | tag3" into ["tag1","tag2"...]
function parseTagsBlob(input, maxTags = 20) {
  const raw = String(input || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/[\n,|]+/g)
    .map(s => s.trim())
    .filter(Boolean);

  const out = [];
  for (const t of parts) {
    if (!t) continue;
    out.push(t);
    if (out.length >= maxTags) break;
  }
  return out;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mbmem')
    .setDescription('MuscleMB memory — view + manage profile facts/notes/tags/opt-in')

    // ✅ NEW: all-in-one setter
    .addSubcommand(sc =>
      sc.setName('set')
        .setDescription('One-shot set: facts + tags + note (admin for others; self allowed if only opt-in)')
        .addUserOption(o => o.setName('user').setDescription('Target user (default: you)').setRequired(false))
        .addStringOption(o => o.setName('facts').setDescription('Facts blob: role=mod, wallet=0xabc | timezone=EST').setRequired(false))
        .addStringOption(o => o.setName('tags').setDescription('Tags blob: vip, whale, builder').setRequired(false))
        .addStringOption(o => o.setName('note').setDescription('Add a single note (optional)').setRequired(false))
        .addBooleanOption(o => o.setName('replace_tags').setDescription('Replace all tags (default: add)').setRequired(false))
    )

    .addSubcommand(sc =>
      sc.setName('view')
        .setDescription('View a profile card (facts + notes + tags + activity)')
        .addUserOption(o => o.setName('user').setDescription('Target user (default: you)').setRequired(false))
        .addIntegerOption(o => o.setName('notes').setDescription('Notes to show (1-10)').setRequired(false))
        .addBooleanOption(o => o.setName('public').setDescription('Show publicly (default: private)').setRequired(false))
    )

    .addSubcommandGroup(g =>
      g.setName('fact')
        .setDescription('Manage facts (key/value)')
        .addSubcommand(sc =>
          sc.setName('set')
            .setDescription('Set a fact: key=value')
            .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
            .addStringOption(o => o.setName('key').setDescription('Fact key (ex: role, wallet)').setRequired(true))
            .addStringOption(o => o.setName('value').setDescription('Fact value').setRequired(true))
        )
        .addSubcommand(sc =>
          sc.setName('del')
            .setDescription('Delete a fact by key')
            .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
            .addStringOption(o => o.setName('key').setDescription('Fact key').setRequired(true))
        )
    )
    .addSubcommandGroup(g =>
      g.setName('note')
        .setDescription('Manage notes (timestamped)')
        .addSubcommand(sc =>
          sc.setName('add')
            .setDescription('Add a note')
            .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
            .addStringOption(o => o.setName('text').setDescription('Note text').setRequired(true))
        )
        .addSubcommand(sc =>
          sc.setName('del')
            .setDescription('Delete a note by id')
            .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
            .addStringOption(o => o.setName('id').setDescription('Note id (from view)').setRequired(true))
        )
    )
    .addSubcommandGroup(g =>
      g.setName('tag')
        .setDescription('Manage tags (labels)')
        .addSubcommand(sc =>
          sc.setName('add')
            .setDescription('Add a tag (vip, whale, builder...)')
            .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
            .addStringOption(o => o.setName('tag').setDescription('Tag').setRequired(true))
        )
        .addSubcommand(sc =>
          sc.setName('del')
            .setDescription('Remove a tag')
            .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
            .addStringOption(o => o.setName('tag').setDescription('Tag').setRequired(true))
        )
        .addSubcommand(sc =>
          sc.setName('clear')
            .setDescription('Clear all tags for a user')
            .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        )
    )
    .addSubcommandGroup(g =>
      g.setName('optin')
        .setDescription('Awareness opt-in controls')
        .addSubcommand(sc =>
          sc.setName('set')
            .setDescription('Set awareness opt-in (self or admin for others)')
            .addUserOption(o => o.setName('user').setDescription('Target user (default: you)').setRequired(false))
            .addBooleanOption(o => o.setName('enabled').setDescription('true/false').setRequired(true))
        )
    ),

  async execute(interaction, { pg } = {}) {
    try {
      if (!interaction?.guildId) {
        await interaction.reply({ content: '⚠️ Use this in a server.', ephemeral: true });
        return;
      }

      const client = interaction.client;
      const db = pg || client?.pg;

      if (!db?.query) {
        await interaction.reply({ content: '⚠️ DB not ready. Try again in a moment.', ephemeral: true });
        return;
      }

      await ProfileStore.ensureSchema(client);
      await MemoryStore.ensureSchema(client);

      const admin = isOwnerOrAdmin(interaction);
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(false);

      const guildId = String(interaction.guildId);

      // ---------- NEW: ONE-SHOT SET ----------
      if (!group && sub === 'set') {
        const target = interaction.options.getUser('user') || interaction.user;
        const targetId = String(target.id);

        const actingId = String(interaction.user.id);
        const managingSelf = targetId === actingId;

        // facts/tags/note
        const factsBlob = interaction.options.getString('facts', false);
        const tagsBlob = interaction.options.getString('tags', false);
        const noteText  = interaction.options.getString('note', false);
        const replaceTags = Boolean(interaction.options.getBoolean('replace_tags') || false);

        const hasAny = Boolean((factsBlob && factsBlob.trim()) || (tagsBlob && tagsBlob.trim()) || (noteText && noteText.trim()));
        if (!hasAny) {
          await interaction.reply({
            content:
              '⚠️ Nothing to set. Provide at least one of: `facts`, `tags`, or `note`.\n' +
              'Example: `/mbmem set facts:"role=mod, wallet=0xabc" tags:"vip, builder" note:"Trusted helper."`',
            ephemeral: true
          });
          return;
        }

        // Admin required if editing others
        if (!managingSelf && !admin) {
          await interaction.reply({ content: '⛔ Admin only to set memory for other users.', ephemeral: true });
          return;
        }

        const facts = parseFactsBlob(factsBlob, 12);
        const tags = parseTagsBlob(tagsBlob, 20);

        const ops = [];
        // tags: replace or add
        if (tags.length) {
          if (replaceTags) {
            ops.push(ProfileStore.clearTags(client, guildId, targetId));
          }
          for (const t of tags) {
            ops.push(ProfileStore.addTag(client, guildId, targetId, t, actingId));
          }
        }

        // facts: upsert each
        if (facts.length) {
          for (const p of facts) {
            ops.push(ProfileStore.setFact(client, guildId, targetId, p.key, p.value, actingId));
          }
        }

        // note: add one
        if (noteText && noteText.trim()) {
          ops.push(ProfileStore.addNote(client, guildId, targetId, noteText, actingId));
        }

        const results = await Promise.allSettled(ops);

        const okCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
        const failCount = results.length - okCount;

        const summaryBits = [];
        if (facts.length) summaryBits.push(`facts: **${facts.length}**`);
        if (tags.length) summaryBits.push(`tags: **${tags.length}**${replaceTags ? ' (replaced)' : ' (added)'}`);
        if (noteText && noteText.trim()) summaryBits.push(`note: **1**`);

        const msg =
          `✅ Saved for <@${targetId}> — ${summaryBits.join(' • ')}` +
          (failCount ? `\n⚠️ Some items failed: ${failCount}/${results.length}` : '');

        await interaction.reply({ content: msg, ephemeral: true });
        return;
      }

      // ---------- VIEW ----------
      if (!group && sub === 'view') {
        const target = interaction.options.getUser('user') || interaction.user;
        const targetId = String(target.id);

        const viewingSelf = targetId === String(interaction.user.id);
        if (!viewingSelf && !admin) {
          await interaction.reply({ content: '⛔ You can only view your own card.', ephemeral: true });
          return;
        }

        const publicFlag = Boolean(interaction.options.getBoolean('public') || false);
        const ephemeral = publicFlag ? false : true;

        const noteLimit = Math.max(1, Math.min(10, Number(interaction.options.getInteger('notes') || 4)));

        const [facts, notes, tags, state] = await Promise.all([
          ProfileStore.getFacts(client, guildId, targetId),
          ProfileStore.getNotes(client, guildId, targetId, noteLimit),
          ProfileStore.getTags(client, guildId, targetId, 20),
          MemoryStore.getUserState(client, guildId, targetId),
        ]);

        const optedIn = Boolean(state?.opted_in);
        const lastActive = fmtRelMs(state?.last_active_ts);
        const lastPing = fmtRelMs(state?.last_ping_ts);

        // Admin-only metadata (who updated)
        const showMeta = Boolean(admin && !ephemeral ? true : admin); // admin can see meta in either mode

        const factsLines = (facts || []).length
          ? (facts || []).map(f => {
              const meta = showMeta && (f.updatedAt || f.updatedBy)
                ? ` _(upd ${fmtRelDate(f.updatedAt)}${f.updatedBy ? ` by <@${String(f.updatedBy)}>` : ''})_`
                : '';
              return `• \`${safeLine(f.key, 32)}\` → **${safeLine(f.value, 180)}**${meta}`;
            })
          : ['_No facts stored._'];

        const tagsInline = (tags || []).length
          ? (tags || []).map(t => `\`${safeLine(t.tag, 24)}\``).join(' ')
          : '_No tags._';

        const notesLines = (notes || []).length
          ? (notes || []).map(n => {
              const meta = showMeta && n.createdBy ? ` _(by <@${String(n.createdBy)}>)_` : '';
              return `• **#${String(n.id)}** ${fmtRelDate(n.createdAt)}${meta} — ${safeLine(n.text, 220)}`;
            })
          : ['_No notes stored._'];

        const factsChunks = chunk(factsLines, 900);
        const notesChunks = chunk(notesLines, 900);

        const embed = new EmbedBuilder()
          .setColor('#9b59b6')
          .setTitle(`🧠 MB Memory Card — ${target.username}`)
          .setDescription(
            `${optedIn ? '🟢' : '⚪'} Awareness: **${optedIn ? 'ON' : 'OFF'}**` +
            `${admin ? ' • 🛡️ Admin' : ''}\n` +
            `🕒 Last active: ${lastActive} • 🏷️ Last ping: ${lastPing}`
          )
          .addFields({ name: 'Tags', value: tagsInline, inline: false });

        if (factsChunks.length === 1) embed.addFields({ name: 'Facts', value: factsChunks[0], inline: false });
        else factsChunks.forEach((c, i) => embed.addFields({ name: i === 0 ? 'Facts' : `Facts (cont. ${i + 1})`, value: c, inline: false }));

        if (notesChunks.length === 1) embed.addFields({ name: `Notes (last ${noteLimit})`, value: notesChunks[0], inline: false });
        else notesChunks.forEach((c, i) => embed.addFields({ name: i === 0 ? `Notes (last ${noteLimit})` : `Notes (cont. ${i + 1})`, value: c, inline: false }));

        embed.setFooter({ text: 'Admin-curated memory per guild. Chat content is NOT auto-saved.' });

        await interaction.reply({ embeds: [embed], ephemeral });
        return;
      }

      // everything below is “management”
      // admin required for managing other users
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const targetId = String(targetUser.id);
      const actingId = String(interaction.user.id);
      const managingSelf = targetId === actingId;

      const requireAdminIfOther = () => {
        if (!managingSelf && !admin) return false;
        return true;
      };

      // ---------- FACT ----------
      if (group === 'fact' && sub === 'set') {
        if (!requireAdminIfOther()) {
          await interaction.reply({ content: '⛔ Admin only to edit other users.', ephemeral: true });
          return;
        }
        const key = interaction.options.getString('key', true);
        const value = interaction.options.getString('value', true);

        const ok = await ProfileStore.setFact(client, guildId, targetId, key, value, actingId);
        await interaction.reply({ content: ok ? `✅ Fact saved for <@${targetId}>: \`${key}\`` : `⚠️ Failed to save fact.`, ephemeral: true });
        return;
      }

      if (group === 'fact' && sub === 'del') {
        if (!requireAdminIfOther()) {
          await interaction.reply({ content: '⛔ Admin only to edit other users.', ephemeral: true });
          return;
        }
        const key = interaction.options.getString('key', true);

        const ok = await ProfileStore.deleteFact(client, guildId, targetId, key);
        await interaction.reply({ content: ok ? `✅ Fact deleted for <@${targetId}>: \`${key}\`` : `⚠️ Failed to delete fact.`, ephemeral: true });
        return;
      }

      // ---------- NOTE ----------
      if (group === 'note' && sub === 'add') {
        if (!requireAdminIfOther()) {
          await interaction.reply({ content: '⛔ Admin only to add notes for other users.', ephemeral: true });
          return;
        }
        const text = interaction.options.getString('text', true);

        const ok = await ProfileStore.addNote(client, guildId, targetId, text, actingId);
        await interaction.reply({ content: ok ? `✅ Note added for <@${targetId}>.` : `⚠️ Failed to add note.`, ephemeral: true });
        return;
      }

      if (group === 'note' && sub === 'del') {
        if (!requireAdminIfOther()) {
          await interaction.reply({ content: '⛔ Admin only to delete notes for other users.', ephemeral: true });
          return;
        }
        const id = interaction.options.getString('id', true);

        const ok = await ProfileStore.deleteNote(client, guildId, targetId, id);
        await interaction.reply({ content: ok ? `✅ Note #${id} deleted for <@${targetId}>.` : `⚠️ Failed to delete note.`, ephemeral: true });
        return;
      }

      // ---------- TAG ----------
      if (group === 'tag' && sub === 'add') {
        if (!requireAdminIfOther()) {
          await interaction.reply({ content: '⛔ Admin only to tag other users.', ephemeral: true });
          return;
        }
        const tag = interaction.options.getString('tag', true);

        const ok = await ProfileStore.addTag(client, guildId, targetId, tag, actingId);
        await interaction.reply({ content: ok ? `✅ Tag added for <@${targetId}>: \`${tag}\`` : `⚠️ Failed to add tag.`, ephemeral: true });
        return;
      }

      if (group === 'tag' && sub === 'del') {
        if (!requireAdminIfOther()) {
          await interaction.reply({ content: '⛔ Admin only to untag other users.', ephemeral: true });
          return;
        }
        const tag = interaction.options.getString('tag', true);

        const ok = await ProfileStore.removeTag(client, guildId, targetId, tag);
        await interaction.reply({ content: ok ? `✅ Tag removed for <@${targetId}>: \`${tag}\`` : `⚠️ Failed to remove tag.`, ephemeral: true });
        return;
      }

      if (group === 'tag' && sub === 'clear') {
        if (!requireAdminIfOther()) {
          await interaction.reply({ content: '⛔ Admin only to clear tags for other users.', ephemeral: true });
          return;
        }
        const ok = await ProfileStore.clearTags(client, guildId, targetId);
        await interaction.reply({ content: ok ? `✅ Tags cleared for <@${targetId}>.` : `⚠️ Failed to clear tags.`, ephemeral: true });
        return;
      }

      // ---------- OPTIN ----------
      if (group === 'optin' && sub === 'set') {
        const enabled = Boolean(interaction.options.getBoolean('enabled', true));
        // self can set self, admin can set anyone
        if (!managingSelf && !admin) {
          await interaction.reply({ content: '⛔ Admin only to set opt-in for other users.', ephemeral: true });
          return;
        }

        const ok = await MemoryStore.setOptIn(client, guildId, targetId, enabled);
        await interaction.reply({
          content: ok
            ? `✅ Awareness opt-in for <@${targetId}> is now **${enabled ? 'ON' : 'OFF'}**.`
            : `⚠️ Failed to set opt-in.`,
          ephemeral: true
        });
        return;
      }

      await interaction.reply({ content: '⚠️ Unknown subcommand.', ephemeral: true });
    } catch (e) {
      console.error('❌ /mbmem error:', e?.stack || e?.message || String(e));
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: '⚠️ Something went wrong.', ephemeral: true });
        } else {
          await interaction.reply({ content: '⚠️ Something went wrong.', ephemeral: true });
        }
      } catch {}
    }
  }
};
