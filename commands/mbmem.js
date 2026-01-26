// commands/mbmem.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

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

  const parts = raw
    .split(/[\n,|]+/g)
    .map(s => s.trim())
    .filter(Boolean);

  const pairs = [];
  for (const p of parts) {
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

/**
 * ✅ Modal ID format used for global routing:
 * mbmem_modal:<guildId>:<targetId>:<actorId>:<stamp>
 */
function makeModalId(guildId, targetId, actorId) {
  const stamp = Date.now().toString(36);
  return `mbmem_modal:${guildId}:${targetId}:${actorId}:${stamp}`;
}

function buildEditModal({ modalId, targetUsername }) {
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(`MB Memory Edit — ${safeLine(targetUsername, 32)}`);

  const facts = new TextInputBuilder()
    .setCustomId('facts')
    .setLabel('Facts (key=value, comma or | separated)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder('role=mod, wallet=0xabc | timezone=EST');

  const tags = new TextInputBuilder()
    .setCustomId('tags')
    .setLabel('Tags (comma or | separated). Use ! to REPLACE tags.')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder('vip, builder  OR  !vip, whale');

  const note = new TextInputBuilder()
    .setCustomId('note')
    .setLabel('Add one note (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder('Trusted helper. Great at onboarding new users.');

  modal.addComponents(
    new ActionRowBuilder().addComponents(facts),
    new ActionRowBuilder().addComponents(tags),
    new ActionRowBuilder().addComponents(note)
  );

  return modal;
}

async function applyEdits({ client, guildId, targetId, actingId, factsBlob, tagsBlobRaw, noteTextRaw }) {
  const facts = parseFactsBlob(factsBlob, 12);

  let replaceTags = false;
  let tagsBlob = String(tagsBlobRaw || '').trim();
  if (tagsBlob.startsWith('!')) {
    replaceTags = true;
    tagsBlob = tagsBlob.slice(1).trim();
  } else if (/^replace\s*:/i.test(tagsBlob)) {
    replaceTags = true;
    tagsBlob = tagsBlob.replace(/^replace\s*:/i, '').trim();
  }

  const tags = parseTagsBlob(tagsBlob, 20);
  const noteText = String(noteTextRaw || '').trim();

  const ops = [];

  // tags
  if (tags.length) {
    if (replaceTags) ops.push(ProfileStore.clearTags(client, guildId, targetId));
    for (const t of tags) ops.push(ProfileStore.addTag(client, guildId, targetId, t, actingId));
  }

  // facts
  if (facts.length) {
    for (const p of facts) ops.push(ProfileStore.setFact(client, guildId, targetId, p.key, p.value, actingId));
  }

  // note
  if (noteText) ops.push(ProfileStore.addNote(client, guildId, targetId, noteText, actingId));

  const results = ops.length ? await Promise.allSettled(ops) : [];
  const okCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  const failCount = results.length - okCount;

  const summaryBits = [];
  if (facts.length) summaryBits.push(`facts: **${facts.length}**`);
  if (tags.length) summaryBits.push(`tags: **${tags.length}**${replaceTags ? ' (replaced)' : ' (added)'}`);
  if (noteText) summaryBits.push(`note: **1**`);

  return {
    ok: failCount === 0,
    changed: Boolean(facts.length || tags.length || noteText),
    replaceTags,
    factsCount: facts.length,
    tagsCount: tags.length,
    noteCount: noteText ? 1 : 0,
    okCount,
    failCount,
    summary: summaryBits.length ? summaryBits.join(' • ') : 'no changes',
  };
}

async function buildMemoryCardEmbed({ client, guildId, target, targetId, noteLimit = 4, showMeta = false, isAdmin = false }) {
  const [facts, notes, tags, state] = await Promise.all([
    ProfileStore.getFacts(client, guildId, targetId),
    ProfileStore.getNotes(client, guildId, targetId, noteLimit),
    ProfileStore.getTags(client, guildId, targetId, 20),
    MemoryStore.getUserState(client, guildId, targetId),
  ]);

  const optedIn = Boolean(state?.opted_in);
  const lastActive = fmtRelMs(state?.last_active_ts);
  const lastPing = fmtRelMs(state?.last_ping_ts);

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
      `${isAdmin ? ' • 🛡️ Admin' : ''}\n` +
      `🕒 Last active: ${lastActive} • 🏷️ Last ping: ${lastPing}`
    )
    .addFields({ name: 'Tags', value: tagsInline, inline: false });

  if (factsChunks.length === 1) embed.addFields({ name: 'Facts', value: factsChunks[0], inline: false });
  else factsChunks.forEach((c, i) => embed.addFields({ name: i === 0 ? 'Facts' : `Facts (cont. ${i + 1})`, value: c, inline: false }));

  if (notesChunks.length === 1) embed.addFields({ name: `Notes (last ${noteLimit})`, value: notesChunks[0], inline: false });
  else notesChunks.forEach((c, i) => embed.addFields({ name: i === 0 ? `Notes (last ${noteLimit})` : `Notes (cont. ${i + 1})`, value: c, inline: false }));

  embed.setFooter({ text: 'Admin-curated memory per guild. Chat content is NOT auto-saved.' });
  return embed;
}

/**
 * ✅ Global modal handler (called by interactionCreate router)
 */
async function handleModalSubmit(interaction, client) {
  try {
    if (!interaction?.isModalSubmit?.()) return false;
    const cid = String(interaction.customId || '');
    if (!cid.startsWith('mbmem_modal:')) return false;

    const parts = cid.split(':'); // mbmem_modal:guildId:targetId:actorId:stamp
    const guildId = parts[1] || '';
    const targetId = parts[2] || '';
    const actorId = parts[3] || '';

    if (!guildId || !targetId || !actorId) {
      await interaction.reply({ content: '⚠️ Invalid modal payload.', ephemeral: true }).catch(() => {});
      return true;
    }

    if (String(interaction.guildId || '') !== String(guildId)) {
      await interaction.reply({ content: '⚠️ Guild mismatch. Re-open /mbmem panel.', ephemeral: true }).catch(() => {});
      return true;
    }

    // only the actor who opened the modal can submit it
    if (String(interaction.user?.id || '') !== String(actorId)) {
      await interaction.reply({ content: '⛔ This modal is not yours. Re-open /mbmem.', ephemeral: true }).catch(() => {});
      return true;
    }

    const admin = isOwnerOrAdmin(interaction);
    const managingSelf = String(targetId) === String(actorId);
    if (!managingSelf && !admin) {
      await interaction.reply({ content: '⛔ Admin only to edit memory for other users.', ephemeral: true }).catch(() => {});
      return true;
    }

    const factsBlob = interaction.fields.getTextInputValue('facts') || '';
    const tagsBlob = interaction.fields.getTextInputValue('tags') || '';
    const noteText = interaction.fields.getTextInputValue('note') || '';

    await ProfileStore.ensureSchema(client);
    await MemoryStore.ensureSchema(client);

    const res = await applyEdits({
      client,
      guildId,
      targetId,
      actingId: actorId,
      factsBlob,
      tagsBlobRaw: tagsBlob,
      noteTextRaw: noteText,
    });

    await interaction.reply({
      content: res.changed
        ? `✅ Saved for <@${targetId}> — ${res.summary}${res.failCount ? `\n⚠️ Some items failed: ${res.failCount}/${res.okCount + res.failCount}` : ''}`
        : '⚠️ No changes detected. (Fill at least one field.)',
      ephemeral: true
    }).catch(() => {});

    return true;
  } catch (e) {
    console.error('❌ mbmem handleModalSubmit error:', e?.stack || e?.message || String(e));
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '⚠️ Failed to process memory modal.' }).catch(() => {});
      } else {
        await interaction.reply({ content: '⚠️ Failed to process memory modal.', ephemeral: true }).catch(() => {});
      }
    } catch {}
    return true;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mbmem')
    .setDescription('MuscleMB memory — view + manage profile facts/notes/tags/opt-in')

    .addSubcommand(sc =>
      sc.setName('panel')
        .setDescription('Open the MB Memory control panel (buttons + modal)')
        .addUserOption(o => o.setName('user').setDescription('Target user (default: you)').setRequired(false))
        .addBooleanOption(o => o.setName('public').setDescription('Panel publicly visible? (default: private)').setRequired(false))
    )

    .addSubcommand(sc =>
      sc.setName('edit')
        .setDescription('Open the memory editor modal (facts + tags + note)')
        .addUserOption(o => o.setName('user').setDescription('Target user (default: you)').setRequired(false))
    )

    .addSubcommand(sc =>
      sc.setName('set')
        .setDescription('One-shot set: facts + tags + note (admin for others)')
        .addUserOption(o => o.setName('user').setDescription('Target user (default: you)').setRequired(false))
        .addStringOption(o => o.setName('facts').setDescription('Facts blob: role=mod, wallet=0xabc | timezone=EST').setRequired(false))
        .addStringOption(o => o.setName('tags').setDescription('Tags blob: vip, whale, builder (use ! to replace)').setRequired(false))
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

  // exports used by router
  applyEdits,
  makeModalId,
  buildEditModal,
  handleModalSubmit,

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

      // ===================== PANEL =====================
      if (!group && sub === 'panel') {
        const target = interaction.options.getUser('user') || interaction.user;
        const targetId = String(target.id);

        const managingSelf = targetId === String(interaction.user.id);
        if (!managingSelf && !admin) {
          await interaction.reply({ content: '⛔ Admin only to open a panel for other users.', ephemeral: true });
          return;
        }

        const publicFlag = Boolean(interaction.options.getBoolean('public') || false);
        const ephemeral = publicFlag ? false : true;

        let state = null;
        try { state = await MemoryStore.getUserState(client, guildId, targetId); } catch {}
        const optedIn = Boolean(state?.opted_in);

        const embed = new EmbedBuilder()
          .setColor('#9b59b6')
          .setTitle(`🧠 MB Memory Panel — ${target.username}`)
          .setDescription(
            `Target: <@${targetId}>\n` +
            `${optedIn ? '🟢' : '⚪'} Awareness: **${optedIn ? 'ON' : 'OFF'}**\n\n` +
            `• **Edit** opens a modal for facts/tags/note\n` +
            `• **Toggle Opt-in** flips awareness for the target\n` +
            `• **View Card** shows the current memory card`
          )
          .setFooter({ text: 'Tip: In modal, start tags with ! to replace all tags.' });

        const btnEdit = new ButtonBuilder()
          .setCustomId('mbmem_btn_edit')
          .setLabel('Edit (Modal)')
          .setStyle(ButtonStyle.Primary);

        const btnOpt = new ButtonBuilder()
          .setCustomId('mbmem_btn_opt')
          .setLabel('Toggle Opt-in')
          .setStyle(ButtonStyle.Secondary);

        const btnView = new ButtonBuilder()
          .setCustomId('mbmem_btn_view')
          .setLabel('View Card')
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(btnEdit, btnOpt, btnView);

        await interaction.reply({ embeds: [embed], components: [row], ephemeral }).catch(() => {});
        const panelMsg = await interaction.fetchReply().catch(() => null);
        if (!panelMsg) return;

        const ownerUserId = String(interaction.user.id);
        const endAt = Date.now() + 60000;

        while (Date.now() < endAt) {
          const btn = await panelMsg.awaitMessageComponent({
            time: Math.max(1000, endAt - Date.now()),
            filter: (i) => String(i.user?.id || '') === ownerUserId,
          }).catch(() => null);

          if (!btn) break;

          try {
            const cid = String(btn.customId || '');

            if (cid === 'mbmem_btn_edit') {
              // ✅ showModal MUST be the first response (no deferUpdate before)
              const modalId = makeModalId(guildId, targetId, ownerUserId);
              const modal = buildEditModal({ modalId, targetUsername: target.username });
              await btn.showModal(modal).catch(async () => {
                await btn.reply({ content: '⚠️ Could not open modal.', ephemeral: true }).catch(() => {});
              });
              continue;
            }

            if (cid === 'mbmem_btn_opt') {
              await btn.deferReply({ ephemeral: true }).catch(() => {});
              const cur = await MemoryStore.getUserState(client, guildId, targetId).catch(() => null);
              const enabled = !(Boolean(cur?.opted_in));
              const ok = await MemoryStore.setOptIn(client, guildId, targetId, enabled).catch(() => false);
              await btn.editReply({
                content: ok
                  ? `✅ Awareness opt-in for <@${targetId}> is now **${enabled ? 'ON' : 'OFF'}**.`
                  : '⚠️ Failed to toggle opt-in.',
              }).catch(() => {});
              continue;
            }

            if (cid === 'mbmem_btn_view') {
              await btn.deferReply({ ephemeral: true }).catch(() => {});
              const embed2 = await buildMemoryCardEmbed({
                client,
                guildId,
                target,
                targetId,
                noteLimit: 4,
                showMeta: Boolean(admin),
                isAdmin: Boolean(admin),
              });
              await btn.editReply({ embeds: [embed2] }).catch(() => {});
              continue;
            }

            await btn.reply({ content: '⚠️ Unknown action.', ephemeral: true }).catch(() => {});
          } catch (e) {
            console.warn('⚠️ /mbmem panel loop error:', e?.message || String(e));
            try {
              if (!btn.deferred && !btn.replied) {
                await btn.reply({ content: '⚠️ Action failed.', ephemeral: true }).catch(() => {});
              }
            } catch {}
          }
        }

        return;
      }

      // ===================== DIRECT MODAL =====================
      if (!group && sub === 'edit') {
        const target = interaction.options.getUser('user') || interaction.user;
        const targetId = String(target.id);
        const managingSelf = targetId === String(interaction.user.id);

        if (!managingSelf && !admin) {
          await interaction.reply({ content: '⛔ Admin only to edit memory for other users.', ephemeral: true });
          return;
        }

        const modalId = makeModalId(guildId, targetId, interaction.user.id);
        const modal = buildEditModal({ modalId, targetUsername: target.username });
        await interaction.showModal(modal);
        return;
      }

      // ===================== ONE-SHOT SET =====================
      if (!group && sub === 'set') {
        const target = interaction.options.getUser('user') || interaction.user;
        const targetId = String(target.id);

        const actingId = String(interaction.user.id);
        const managingSelf = targetId === actingId;

        const factsBlob = interaction.options.getString('facts', false);
        const tagsBlobRaw = interaction.options.getString('tags', false);
        const noteTextRaw = interaction.options.getString('note', false);
        const replaceTagsFlag = Boolean(interaction.options.getBoolean('replace_tags') || false);

        const hasAny = Boolean((factsBlob && factsBlob.trim()) || (tagsBlobRaw && tagsBlobRaw.trim()) || (noteTextRaw && noteTextRaw.trim()));
        if (!hasAny) {
          await interaction.reply({
            content:
              '⚠️ Nothing to set. Provide at least one of: `facts`, `tags`, or `note`.\n' +
              'Example: `/mbmem set facts:"role=mod, wallet=0xabc" tags:"vip, builder" note:"Trusted helper."`',
            ephemeral: true
          });
          return;
        }

        if (!managingSelf && !admin) {
          await interaction.reply({ content: '⛔ Admin only to set memory for other users.', ephemeral: true });
          return;
        }

        let tagsBlob = String(tagsBlobRaw || '').trim();
        if (replaceTagsFlag && tagsBlob && !tagsBlob.startsWith('!')) tagsBlob = '!' + tagsBlob;

        const res = await applyEdits({
          client,
          guildId,
          targetId,
          actingId,
          factsBlob,
          tagsBlobRaw: tagsBlob,
          noteTextRaw,
        });

        await interaction.reply({
          content: res.changed
            ? `✅ Saved for <@${targetId}> — ${res.summary}${res.failCount ? `\n⚠️ Some items failed: ${res.failCount}/${res.okCount + res.failCount}` : ''}`
            : '⚠️ No changes detected.',
          ephemeral: true
        });
        return;
      }

      // ===================== VIEW =====================
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

        const embed = await buildMemoryCardEmbed({
          client,
          guildId,
          target,
          targetId,
          noteLimit,
          showMeta: Boolean(admin),
          isAdmin: Boolean(admin),
        });

        await interaction.reply({ embeds: [embed], ephemeral });
        return;
      }

      await interaction.reply({ content: '⚠️ Unknown subcommand.', ephemeral: true });
    } catch (e) {
      console.error('❌ /mbmem error:', e?.stack || e?.message || String(e));
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: '⚠️ Something went wrong.' });
        } else {
          await interaction.reply({ content: '⚠️ Something went wrong.', ephemeral: true });
        }
      } catch {}
    }
  }
};

