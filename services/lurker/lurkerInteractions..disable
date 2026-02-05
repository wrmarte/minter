// services/lurker/lurkerInteractions.js
// ======================================================
// LURKER: Button interactions
// - lurker_ignore:<ruleId>:<listingId> -> mark seen + reply
// - lurker_buy:<ruleId>:<listingId>    -> sim mode + mark seen
//
// Notes:
// - We only dedupe by inserting into lurker_seen.
// - We do NOT execute purchases here (safe).
// ======================================================

function s(v) { return String(v || "").trim(); }

async function markSeen(client, ruleId, listingId) {
  const pg = client?.pg;
  if (!pg?.query) throw new Error("DB not ready (client.pg missing)");

  await pg.query(
    `INSERT INTO lurker_seen(rule_id, listing_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [Number(ruleId), String(listingId)]
  );
}

function parseCustomId(customId) {
  // allow listingId to contain ":" so we only split first two
  const raw = String(customId || "");
  const first = raw.indexOf(":");
  const second = first >= 0 ? raw.indexOf(":", first + 1) : -1;

  if (first < 0 || second < 0) return null;

  const action = raw.slice(0, first);          // lurker_buy / lurker_ignore
  const ruleId = raw.slice(first + 1, second); // number
  const listingId = raw.slice(second + 1);     // rest

  return { action, ruleId, listingId };
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
    return interaction.reply(payload);
  } catch {
    return null;
  }
}

async function handleLurkerButton(interaction, client) {
  const id = String(interaction.customId || "");
  if (!id.startsWith("lurker_buy:") && !id.startsWith("lurker_ignore:")) return false;

  const parsed = parseCustomId(id);
  if (!parsed) {
    await safeReply(interaction, { content: "⚠️ Invalid Lurker button payload.", ephemeral: true });
    return true;
  }

  const { action, ruleId, listingId } = parsed;

  const rid = Number(ruleId);
  if (!rid || !Number.isFinite(rid) || !listingId) {
    await safeReply(interaction, { content: "⚠️ Invalid Lurker button payload (missing rule/listing).", ephemeral: true });
    return true;
  }

  try {
    // Always mark seen so it doesn't keep re-alerting
    await markSeen(client, rid, listingId);

    if (action === "lurker_ignore") {
      await safeReply(interaction, {
        content: `🟢 Ignored listing (rule **#${rid}**).`,
        ephemeral: true
      });
      return true;
    }

    if (action === "lurker_buy") {
      // SIM MODE ONLY
      await safeReply(interaction, {
        content: `🟢 Buy clicked (rule **#${rid}**).\n✅ Marked as seen.\n⚠️ Execution is OFF (sim-only). Next step: wire marketplace execution with owner-only + vault guards.`,
        ephemeral: true
      });
      return true;
    }

    await safeReply(interaction, { content: "⚠️ Unknown Lurker action.", ephemeral: true });
    return true;
  } catch (e) {
    await safeReply(interaction, {
      content: `⚠️ Lurker button failed: ${s(e?.message || e).slice(0, 180)}`,
      ephemeral: true
    });
    return true;
  }
}

module.exports = { handleLurkerButton };
