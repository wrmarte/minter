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
  ComponentType,
} = require('discord.js');

const ProfileStore = require('../listeners/musclemb/profileStore');
const MemoryStore = require('../listeners/musclemb/memoryStore');

/* ======================================================
   CONFIG LIMITS + SAFETY
====================================================== */
const MBMEM_NOTE_LIMIT_DEFAULT = 4;
const MBMEM_HARD_STR_CAP = Number(process.env.MBMEM_HARD_STR_CAP || 6000);
const MBMEM_MAX_FACTS_RENDER = Number(process.env.MBMEM_MAX_FACTS_RENDER || 40);
const MBMEM_MAX_TAGS_RENDER  = Number(process.env.MBMEM_MAX_TAGS_RENDER  || 40);
const MBMEM_CHUNK_MAX = 900;

const MBMEM_DEBUG = String(process.env.MBMEM_DEBUG || '0').trim() === '1';
function dlog(...a) { if (MBMEM_DEBUG) console.log('[MBMEM]', ...a); }
function dwarn(...a) { console.warn('[MBMEM]', ...a); }

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

/**
 * Safe string normalizer:
 * - Caps BEFORE regex
 * - Replaces whitespace
 * - Trims + max clamp
 */
function safeLine(s, max = 160) {
  let t = String(s ?? '');
  if (!t) return '';
  if (t.length > MBMEM_HARD_STR_CAP) t = t.slice(0, MBMEM_HARD_STR_CAP);
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function chunk(lines, maxChars = MBMEM_CHUNK_MAX) {
  const out = [];
  let buf = [];
  let len = 0;

  for (const line of lines) {
    const l = String(line || '');
    const addLen = (buf.length ? 1 : 0) + l.length;
    if (len + addLen > maxChars) {
      if (buf.length) out.push(buf.join('\n'));
      buf = [l];
      len = l.length;
    } else {
      if (buf.length) len += 1;
      buf.push(l);
      len += l.length;
    }
  }
  if (buf.length) out.push(buf.join('\n'));
  return out;
}

// Parse "k=v, k2=v2 | k3=v3"
function parseFactsBlob(input, maxPairs = 12) {
  let raw = String(input || '').trim();
  if (!raw) return [];
  if (raw.length > MBMEM_HARD_STR_CAP) raw = raw.slice(0, MBMEM_HARD_STR_CAP);

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

// Parse "tag1, tag2 | tag3"
function parseTagsBlob(input, maxTags = 20) {
  let raw = String(input || '').trim();
  if (!raw) return [];
  if (raw.length > MBMEM_HARD_STR_CAP) raw = raw.slice(0, MBMEM_HARD_STR_CAP);

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

/**
 * ✅ Hardcode ALL labels to tiny constants (never computed).
 * This prevents any shapeshift String validator explosion.
 */
const LABEL_FACTS = 'Facts (key=value)';
const LABEL_TAGS  = 'Tags (! to replace)';
const LABEL_NOTE  = 'Add a note (optional)';

function buildEditModal({ modalId, targetUsername }) {
  // Title is the only dynamic string — keep it short and sanitized
  const safeTitleUser = safeLine(targetUsername, 24) || 'User';
  const title = `MB Memory Edit — ${safeTitleUser}`; // small

  const modal = new ModalBuilder()
    .setCustomId(String(modalId || '').slice(0, 95)) // Discord customId max ~100
    .setTitle(title.slice(0, 45)); // Discord title limit

  const facts = new TextInputBuilder()
    .setCustomId('facts')
    .setLabel(LABEL_FACTS)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder('role=mod, wallet=0xabc | timezone=EST');

  const tags = new TextInputBuilder()
    .setCustomId('tags')
    .setLabel(LABEL_TAGS)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder('vip, builder  OR  !vip, whale');

  const note = new TextInputBuilder()
    .setCustomId('note')
    .setLabel(LABEL_NOTE)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder('Trusted helper. Great at onboarding.');

  modal.addComponents(
    new ActionRowBuilder().addComponents(facts),
    new ActionRowBuilder().addComponents(tags),
    new ActionRowBuilder().addComponents(note)
  );

  return modal;
}

/**
 * ✅ Never let modal creation crash the collector.
 */
async function safeShowModal(btnInteraction, modalFactoryFn) {
  try {
    const modal = modalFactoryFn();
    await btnInteraction.showModal(modal);
    return true;
  } catch (e) {
    dwarn('safeShowModal error:', e?.stack || e?.message || String(e));
    try {
      if (!btnInteraction.deferred && !btnInteraction.replied) {
        await btnInteraction.reply({
          content: '⚠️ Could not open the modal. (Builder error) Try `/mbmem edit` instead.',
          ephemeral: true
        });
      }
    } catch {}
    return false;
  }
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

  let noteText = String(noteTextRaw || '').trim();
  if (noteText.length > MBMEM_HARD_STR_CAP) noteText = noteText.slice(0, MBMEM_HARD_STR_CAP);

  const ops = [];

  if (tags.length) {
    if (replaceTags) ops.push(ProfileStore.clearTags(client, guildId, targetId));
    for (const t of tags) ops.push(ProfileStore.addTag(client, guildId, targetId, t, actingId));
  }

  if (facts.length) {
    for (const p of facts) ops.push(ProfileStore.setFact(client, guildId, targetId, p.key, p.value, actingId));
  }

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

async function buildMemoryCardEmbed({ client, guildId, target, targetId, noteLimit = MBMEM_NOTE_LIMIT_DEFAULT, showMeta = false, isAdmin = false }) {
  const [factsRaw, notesRaw, tagsRaw, state] = await Promise.all([
    ProfileStore.getFacts(client, guildId, targetId),
    ProfileStore.getNotes(client, guildId, targetId, noteLimit),
    ProfileStore.getTags(client, guildId, targetId, 100),
    MemoryStore.getUserState(client, guildId, targetId),
  ]);

  const optedIn = Boolean(state?.opted_in);
  const lastActive = fmtRelMs(state?.last_active_ts);
  const lastPing = fmtRelMs(state?.last_ping_ts);

  const facts = Array.isArray(factsRaw) ? factsRaw.slice(0, MBMEM_MAX_FACTS_RENDER) : [];
  const tags  = Array.isArray(tagsRaw)  ? tagsRaw.slice(0, MBMEM_MAX_TAGS_RENDER)  : [];
  const notes = Array.isArray(notesRaw) ? notesRaw : [];

  const factsOverflow = Math.max(0, (Array.isArray(factsRaw) ? factsRaw.length : 0) - facts.length);
  const tagsOverflow  = Math.max(0, (Array.isArray(tagsRaw) ? tagsRaw.length : 0) - tags.length);

  const factsLines = facts.length
    ? facts.map(f => {
        const meta = showMeta && (f.updatedAt || f.updatedBy)
          ? ` _(upd ${fmtRelDate(f.updatedAt)}${f.updatedBy ? ` by <@${String(f.updatedBy)}>` : ''})_`
          : '';
        return `• \`${safeLine(f.key, 32)}\` → **${safeLine(f.value, 180)}**${meta}`;
      })
    : ['_No facts stored._'];

  if (factsOverflow > 0) factsLines.push(`_…and **${factsOverflow}** more facts_`);

  const tagsInline = tags.length
    ? tags.map(t => `\`${safeLine(t.tag, 24)}\``).join(' ')
    : '_No tags._';

  const tagsSuffix = tagsOverflow > 0 ? `\n_…and **${tagsOverflow}** more tags_` : '';

  const notesLines = notes.length
    ? notes.map(n => {
        const meta = showMeta && n.createdBy ? ` _(by <@${String(n.createdBy)}>)_` : '';
        return `• **#${String(n.id)}** ${fmtRelDate(n.createdAt)}${meta} — ${safeLine(n.text, 220)}`;
      })
    : ['_No notes stored._'];

  const factsChunks = chunk(factsLines, MBMEM_CHUNK_MAX);
  const notesChunks = chunk(notesLines, MBMEM_CHUNK_MAX);

  const embed = new EmbedBuilder()
    .setColor('#9b59b6')
    .setTitle(`🧠 MB Memory Card — ${target.username}`)
    .setDescription(
      `${optedIn ? '🟢' : '⚪'} Awareness: **${optedIn ? 'ON' : 'OFF'}**` +
      `${isAdmin ? ' • 🛡️ Admin' : ''}\n` +
      `🕒 Last active: ${lastActive} • 🏷️ Last ping: ${lastPing}`
    )
    .addFields({ name: 'Tags', value: (tagsInline + tagsSuffix).slice(0, 1024), inline: false });

  if (factsChunks.length === 1) embed.addFields({ name: 'Facts', value: factsChunks[0], inline: false });
  else factsChunks.forEach((c, i) => embed.addFields({ name: i === 0 ? 'Facts' : `Facts (cont. ${i + 1})`, value: c, inline: false }));

  if (notesChunks.length === 1) embed.addFields({ name: `Notes (last ${noteLimit})`, value: notesChunks[0], inline: false });
  else notesChunks.forEach((c, i) => embed.addFields({ name: i === 0 ? `Notes (last ${noteLimit})` : `Notes (cont. ${i + 1})`, value: c, inline: false }));

  embed.setFooter({ text: 'Admin-curated memory per guild. Chat content is NOT auto-saved.' });
  return embed;
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
      sc.setName('view')
        .setDescription('View a profile card (facts + notes + tags + activity)')
        .addUserOption(o => o.setName('user').setDescription('Target user (default: you)').setRequired(false))
        .addIntegerOption(o => o.setName('notes').setDescription('Notes to show (1-10)').setRequired(false))
        .addBooleanOption(o => o.setName('public').setDescription('Show publicly (default: private)').setRequired(false))
    ),

  applyEdits,
  makeModalId,
  buildEditModal,

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
      if (!client.pg) client.pg = db;

      await ProfileStore.ensureSchema(client);
      await MemoryStore.ensureSchema(client);

      const admin = isOwnerOrAdmin(interaction);
      const sub = interaction.options.getSubcommand(false);
      const guildId = String(interaction.guildId);

      // ===================== PANEL =====================
      if (sub === 'panel') {
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
            `• **View Card** shows the current memory card`
          )
          .setFooter({ text: 'Tip: In modal, start tags with ! to replace all tags.' });

        const ownerUserId = String(interaction.user.id);
        const token = `${guildId}:${targetId}:${ownerUserId}`;

        const btnEdit = new ButtonBuilder()
          .setCustomId(`mbmem_btn_edit:${token}`)
          .setLabel('Edit')
          .setStyle(ButtonStyle.Primary);

        const btnView = new ButtonBuilder()
          .setCustomId(`mbmem_btn_view:${token}`)
          .setLabel('View')
          .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(btnEdit, btnView);

        await interaction.reply({ embeds: [embed], components: [row], ephemeral }).catch(() => {});
        const panelMsg = await interaction.fetchReply().catch(() => null);
        if (!panelMsg) return;

        const collector = panelMsg.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 60_000,
        });

        collector.on('collect', async (btn) => {
          try {
            const cid = String(btn.customId || '');
            const parts = cid.split(':');
            const kind = parts[0] || '';
            const gid = parts[1] || '';
            const tid = parts[2] || '';
            const owner = parts[3] || '';

            if (gid !== guildId || tid !== targetId || owner !== ownerUserId) {
              await btn.reply({ content: `⛔ This panel belongs to <@${ownerUserId}>.`, ephemeral: true }).catch(() => {});
              return;
            }
            if (String(btn.user?.id || '') !== ownerUserId) {
              await btn.reply({ content: `⛔ Only <@${ownerUserId}> can use these buttons.`, ephemeral: true }).catch(() => {});
              return;
            }

            if (kind === 'mbmem_btn_edit') {
              const modalId = makeModalId(guildId, targetId, ownerUserId);
              await safeShowModal(btn, () => buildEditModal({ modalId, targetUsername: target.username }));
              return;
            }

            if (kind === 'mbmem_btn_view') {
              await btn.deferReply({ ephemeral: true }).catch(() => {});
              const embed2 = await buildMemoryCardEmbed({
                client,
                guildId,
                target,
                targetId,
                noteLimit: MBMEM_NOTE_LIMIT_DEFAULT,
                showMeta: Boolean(admin),
                isAdmin: Boolean(admin),
              });
              await btn.editReply({ embeds: [embed2] }).catch(() => {});
              return;
            }
          } catch (e) {
            dwarn('panel collector error:', e?.stack || e?.message || String(e));
            try {
              if (!btn.deferred && !btn.replied) {
                await btn.reply({ content: '⚠️ Action failed.', ephemeral: true }).catch(() => {});
              }
            } catch {}
          }
        });

        collector.on('end', async () => {
          try {
            const disabledRow = new ActionRowBuilder().addComponents(
              ButtonBuilder.from(btnEdit).setDisabled(true),
              ButtonBuilder.from(btnView).setDisabled(true),
            );
            await interaction.editReply({ components: [disabledRow] }).catch(() => {});
          } catch {}
        });

        return;
      }

      // ===================== DIRECT MODAL =====================
      if (sub === 'edit') {
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

      // ===================== VIEW =====================
      if (sub === 'view') {
        const target = interaction.options.getUser('user') || interaction.user;
        const targetId = String(target.id);

        const viewingSelf = targetId === String(interaction.user.id);
        if (!viewingSelf && !admin) {
          await interaction.reply({ content: '⛔ You can only view your own card.', ephemeral: true });
          return;
        }

        const publicFlag = Boolean(interaction.options.getBoolean('public') || false);
        const ephemeral = publicFlag ? false : true;

        const noteLimit = Math.max(1, Math.min(10, Number(interaction.options.getInteger('notes') || MBMEM_NOTE_LIMIT_DEFAULT)));

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
