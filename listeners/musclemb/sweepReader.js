// listeners/musclemb/sweepReader.js
const { EmbedBuilder } = require('discord.js');
const Config = require('./config');
const Utils = require('./utils');
const { safeReplyMessage } = require('./messaging');

function isTriggered(lowered) {
  const t = (lowered || '').toLowerCase();
  return Config.SWEEP_TRIGGERS.some(x => t.includes(x));
}

async function getSweepSnapshot(client, guildId) {
  try {
    if (client?.sweepPower && typeof client.sweepPower.getSnapshot === 'function') {
      const snap = await client.sweepPower.getSnapshot(guildId);
      if (snap) return { source: 'client.sweepPower.getSnapshot', snap };
    }
  } catch {}

  try {
    if (client?.sweepPowerSnapshot && typeof client.sweepPowerSnapshot === 'object') {
      return { source: 'client.sweepPowerSnapshot', snap: client.sweepPowerSnapshot };
    }
  } catch {}

  try {
    if (client?.__sweepPowerCache && typeof client.__sweepPowerCache.get === 'function') {
      const snap = client.__sweepPowerCache.get(guildId) || client.__sweepPowerCache.get('global') || null;
      if (snap) return { source: 'client.__sweepPowerCache', snap };
    }
  } catch {}

  if (!client?.pg || typeof client.pg.query !== 'function') {
    return { source: 'none', snap: null };
  }

  const queries = [
    {
      name: 'sweep_power (per server)',
      sql: `SELECT * FROM sweep_power WHERE server_id = $1 ORDER BY updated_at DESC NULLS LAST, ts DESC NULLS LAST, id DESC NULLS LAST LIMIT 1`,
      params: [guildId],
    },
    {
      name: 'sweep_power (global)',
      sql: `SELECT * FROM sweep_power ORDER BY updated_at DESC NULLS LAST, ts DESC NULLS LAST, id DESC NULLS LAST LIMIT 1`,
      params: [],
    },
    {
      name: 'sweep_power_checkpoints',
      sql: `SELECT * FROM sweep_power_checkpoints WHERE server_id = $1 ORDER BY ts DESC NULLS LAST, id DESC NULLS LAST LIMIT 1`,
      params: [guildId],
    },
  ];

  for (const q of queries) {
    try {
      const r = await client.pg.query(q.sql, q.params);
      const row = r?.rows?.[0];
      if (row) return { source: `pg:${q.name}`, snap: row };
    } catch {}
  }

  return { source: 'pg:none', snap: null };
}

function normalizeSweepSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const power =
    raw.power ?? raw.sweep_power ?? raw.sweeppower ?? raw.current_power ?? raw.current ?? raw.value ?? null;

  const delta =
    raw.delta ?? raw.power_delta ?? raw.change ?? raw.diff ?? raw.delta_power ?? null;

  const total =
    raw.total ?? raw.total_power ?? raw.sum ?? raw.accum ?? null;

  const lastTs =
    raw.updated_at?.getTime?.() ? raw.updated_at.getTime()
    : raw.updated_at ?? raw.ts ?? raw.timestamp ?? raw.last_ts ?? null;

  const lastBlock =
    raw.block ?? raw.last_block ?? raw.block_number ?? raw.lastBlock ?? null;

  const engineTx =
    raw.tx ?? raw.tx_hash ?? raw.transaction_hash ?? raw.hash ?? raw.engine_tx ?? null;

  const note =
    raw.note ?? raw.reason ?? raw.meta ?? null;

  return { power, delta, total, lastTs, lastBlock, engineTx, note };
}

async function sendEmbed(message, snapshot, sourceLabel = '') {
  const norm = normalizeSweepSnapshot(snapshot);
  if (!norm) {
    try { await safeReplyMessage(message.client, message, { content: '⚠️ Sweep reader: no snapshot available yet.' }); } catch {}
    return;
  }

  const d = Utils.safeDate(norm.lastTs);
  const updatedStr = d ? `<t:${Math.floor(d.getTime() / 1000)}:R>` : 'Unknown';

  const embed = new EmbedBuilder()
    .setColor('#2ecc71')
    .setTitle('🧹 Engine Sweep — Power Read')
    .setDescription('Here’s the latest sweep-power snapshot I can see.')
    .addFields(
      { name: 'Power', value: `**${Utils.fmtNum(norm.power, 2)}**`, inline: true },
      { name: 'Δ Change', value: `**${Utils.fmtSigned(norm.delta, 2)}**`, inline: true },
      { name: 'Total', value: `**${Utils.fmtNum(norm.total, 2)}**`, inline: true },
      { name: 'Updated', value: updatedStr, inline: true },
      { name: 'Block', value: norm.lastBlock != null ? String(norm.lastBlock) : 'N/A', inline: true },
      { name: 'Source', value: sourceLabel || 'unknown', inline: true },
    );

  if (norm.engineTx) {
    const tx = String(norm.engineTx);
    embed.addFields({ name: 'Tx', value: tx.length > 80 ? `${tx.slice(0, 77)}…` : tx, inline: false });
  }
  if (norm.note) {
    const n = String(norm.note);
    embed.addFields({ name: 'Note', value: n.length > 250 ? `${n.slice(0, 247)}…` : n, inline: false });
  }

  try {
    await safeReplyMessage(message.client, message, { embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    try {
      await safeReplyMessage(message.client, message, {
        content: `🧹 Sweep Power: ${Utils.fmtNum(norm.power, 2)} | Δ ${Utils.fmtSigned(norm.delta, 2)} | Updated: ${updatedStr}`,
        allowedMentions: { parse: [] }
      });
    } catch {}
  }
}

module.exports = { isTriggered, getSweepSnapshot, sendEmbed };
