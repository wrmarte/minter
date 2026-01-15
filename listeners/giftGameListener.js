// listeners/giftGameListener.js
// ======================================================
// Gift Drop Guess Game — Runtime Engine
// UPDATE:
// ✅ Public mode: bot responds with hot/cold or high/low (configurable)
// ✅ Replies can auto-delete to reduce spam
// ✅ Modal submit: deferReply() prevents 10062 Unknown interaction
// ✅ Winner reveal: embed uses ACTUAL NFT image URL when available
// ✅ Winner reveal: adds NFT name + tokenId lines when provided
// ✅ Progressive hints begin after 75% time has passed (3-stage)
// ✅ No manual DB changes: safe ALTER TABLE IF NOT EXISTS
// ======================================================

const crypto = require("crypto");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  PermissionsBitField,
} = require("discord.js");

let ensureGiftSchema = null;
try {
  const mod = require("../services/gift/ensureGiftSchema");
  if (mod && typeof mod.ensureGiftSchema === "function") ensureGiftSchema = mod.ensureGiftSchema;
} catch {}

let renderGiftRevealCard = null;
try {
  const rr = require("../services/gift/revealRenderer");
  if (rr && typeof rr.renderGiftRevealCard === "function") renderGiftRevealCard = rr.renderGiftRevealCard;
} catch {}

const DEBUG = String(process.env.GIFT_DEBUG || "").trim() === "1";

const GIFT_REVEAL_GIF =
  (process.env.GIFT_REVEAL_GIF || "").trim() ||
  "https://media.giphy.com/media/3o6Zt481isNVuQI1l6/giphy.gif";

function nowMs() { return Date.now(); }

function safeStr(v, max = 160) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function intFromText(s) {
  const t = String(s || "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function isDataUrl(s) {
  const t = String(s || "").trim();
  return /^data:/i.test(t);
}

function hintHighLow(guess, target) {
  if (guess === target) return "correct";
  return guess > target ? "too_high" : "too_low";
}

function hintHotCold(guess, target) {
  if (guess === target) return "correct";
  const d = Math.abs(guess - target);
  if (d <= 3) return "hot";
  if (d <= 10) return "warm";
  if (d <= 20) return "cold";
  return "frozen";
}

function hintToUserText(hint) {
  switch (hint) {
    case "correct": return "🎯 **CORRECT!**";
    case "too_high": return "🔻 **Too high.**";
    case "too_low": return "🔺 **Too low.**";
    case "hot": return "🔥 **HOT.**";
    case "warm": return "🌡️ **Warm.**";
    case "cold": return "🧊 **Cold.**";
    case "frozen": return "🥶 **Frozen.**";
    default: return "✅ Locked in.";
  }
}

async function ensureSchemaIfNeeded(client) {
  try {
    if (client.__giftSchemaReady) return true;
    if (!ensureGiftSchema) return false;
    const ok = await ensureGiftSchema(client);
    return Boolean(ok);
  } catch (e) {
    console.warn("⚠️ [GIFT] ensureSchemaIfNeeded failed:", e?.message || e);
    return false;
  }
}

async function ensureGiftConfigColumns(pg) {
  const alters = [
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS public_hint_mode TEXT DEFAULT 'reply';`,
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS public_hint_delete_ms INT DEFAULT 8000;`,
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS public_out_of_range_feedback BOOLEAN DEFAULT FALSE;`,
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS progressive_hints_enabled BOOLEAN DEFAULT TRUE;`,
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS progressive_hint_delete_ms INT DEFAULT 0;`,
  ];
  for (const q of alters) {
    try { await pg.query(q); } catch {}
  }
}

async function ensureGiftGamesHintColumns(pg) {
  // ✅ store hint stage in DB so restarts do not spam
  const alters = [
    `ALTER TABLE gift_games ADD COLUMN IF NOT EXISTS hint_stage INT DEFAULT 0;`,
    `ALTER TABLE gift_games ADD COLUMN IF NOT EXISTS last_hint_at TIMESTAMPTZ;`,
  ];
  for (const q of alters) {
    try { await pg.query(q); } catch {}
  }
}

async function getGiftConfig(pg, guildId) {
  await ensureGiftConfigColumns(pg);

  await pg.query(
    `INSERT INTO gift_config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`,
    [guildId]
  ).catch(() => {});

  const r = await pg.query(`SELECT * FROM gift_config WHERE guild_id=$1`, [guildId]);
  return r.rows?.[0] || null;
}

async function getActiveGiftGameInChannel(pg, guildId, channelId) {
  const r = await pg.query(
    `SELECT * FROM gift_games
     WHERE guild_id=$1 AND status='active' AND channel_id=$2
     ORDER BY started_at DESC LIMIT 1`,
    [guildId, channelId]
  );
  return r.rows?.[0] || null;
}

async function getGiftGameById(pg, gameId) {
  const r = await pg.query(`SELECT * FROM gift_games WHERE id=$1 LIMIT 1`, [gameId]);
  return r.rows?.[0] || null;
}

async function getUserState(pg, guildId, userId) {
  const r = await pg.query(
    `SELECT * FROM gift_user_state WHERE guild_id=$1 AND user_id=$2`,
    [guildId, userId]
  );
  return r.rows?.[0] || null;
}

async function writeAudit(pg, { guild_id, game_id = null, action, actor_user_id, actor_tag, details }) {
  try {
    await pg.query(
      `
      INSERT INTO gift_audit (guild_id, game_id, action, actor_user_id, actor_tag, details)
      VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [guild_id, game_id, action, actor_user_id, actor_tag, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    if (DEBUG) console.warn("⚠️ [GIFT] audit insert failed:", e?.message || e);
  }
}

async function upsertUserStateOnGuess(pg, { guildId, userId, gameId, addWin = false }) {
  const q = `
    INSERT INTO gift_user_state (
      guild_id, user_id,
      last_guess_at, guesses_in_game, last_game_id,
      wins_total, guesses_total,
      updated_at
    ) VALUES ($1,$2, NOW(), 1, $3, $4, 1, NOW())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      last_guess_at = NOW(),
      guesses_in_game = CASE
        WHEN gift_user_state.last_game_id IS DISTINCT FROM EXCLUDED.last_game_id THEN 1
        ELSE gift_user_state.guesses_in_game + 1
      END,
      last_game_id = EXCLUDED.last_game_id,
      wins_total = gift_user_state.wins_total + $4,
      guesses_total = gift_user_state.guesses_total + 1,
      updated_at = NOW()
    RETURNING *;
  `;
  const winInc = addWin ? 1 : 0;
  const r = await pg.query(q, [guildId, userId, gameId, winInc]);
  return r.rows?.[0] || null;
}

async function insertGuess(pg, { gameId, guildId, channelId, userId, userTag, guessValue, source, messageId, isCorrect, hint }) {
  const q = `
    INSERT INTO gift_guesses (
      game_id, guild_id, channel_id, user_id, user_tag,
      guess_value, source, message_id,
      is_correct, hint
    ) VALUES (
      $1,$2,$3,$4,$5,
      $6,$7,$8,
      $9,$10
    )
    RETURNING *;
  `;
  const r = await pg.query(q, [
    gameId, guildId, channelId, userId, userTag || null,
    guessValue, source, messageId || null,
    Boolean(isCorrect), hint || null
  ]);
  return r.rows?.[0] || null;
}

async function incrementGameGuessCount(pg, gameId) {
  try {
    await pg.query(`UPDATE gift_games SET total_guesses = total_guesses + 1 WHERE id=$1`, [gameId]);
  } catch (e) {
    if (DEBUG) console.warn("⚠️ [GIFT] increment total_guesses failed:", e?.message || e);
  }
}

async function computeUniquePlayers(pg, gameId) {
  const r = await pg.query(`SELECT COUNT(DISTINCT user_id) AS n FROM gift_guesses WHERE game_id=$1`, [gameId]);
  const n = Number(r.rows?.[0]?.n || 0);
  return Number.isFinite(n) ? n : 0;
}

function disableAllComponents(components) {
  try {
    if (!Array.isArray(components)) return [];
    return components.map(row => {
      const newRow = ActionRowBuilder.from(row);
      newRow.components = newRow.components.map(c => {
        const b = ButtonBuilder.from(c);
        b.setDisabled(true);
        return b;
      });
      return newRow;
    });
  } catch {
    return [];
  }
}

function buildWinnerEmbed({
  game,
  winnerId,
  winnerTag,
  winNum,
  elapsedSec,
  totalGuesses,
  uniquePlayers,
  revealPrizeText,
  nftDisplayLine,
  nftMetaLine,
}) {
  const lines = [
    `**Winner:** <@${winnerId}>${winnerTag ? ` (\`${winnerTag}\`)` : ""}`,
    `**Winning Number:** \`${winNum}\``,
    `**Time to Win:** \`${elapsedSec}s\``,
    `**Total Guesses:** \`${totalGuesses}\``,
    `**Unique Players:** \`${uniquePlayers}\``,
    "",
    `🎁 **Prize Revealed:** ${revealPrizeText}`,
  ];

  if (nftDisplayLine) lines.push(nftDisplayLine);
  if (nftMetaLine) lines.push(nftMetaLine);

  const e = new EmbedBuilder()
    .setTitle("🏆 GIFT OPENED — WE HAVE A WINNER!")
    .setDescription(lines.join("\n"))
    .setThumbnail(GIFT_REVEAL_GIF);

  if (game?.commit_enabled && game?.commit_hash) {
    e.addFields({
      name: "✅ Fairness Proof",
      value:
        `Commit Hash: \`${game.commit_hash}\`\n` +
        `Reveal: \`${game.winning_guess}:${game.commit_salt}\`\n` +
        `Verify SHA256(target:salt) == commit hash`,
      inline: false
    });
  }

  e.setFooter({ text: `Game ID: ${game.id}` });
  return e;
}

function parsePrizePayload(wonGame) {
  try {
    if (wonGame.prize_payload && typeof wonGame.prize_payload === "object") return wonGame.prize_payload;
    return wonGame.prize_payload ? JSON.parse(wonGame.prize_payload) : null;
  } catch {
    return null;
  }
}

function buildNftDisplayFromPayload(payload) {
  if (!payload || typeof payload !== "object") return { display: null, meta: null };

  const chain = safeStr(payload.chain || payload.network || payload.net || "", 20);
  const contract = safeStr(payload.contract || payload.ca || payload.address || "", 80);
  const tokenId = safeStr(payload.tokenId || payload.token_id || payload.id || payload.token || payload.tokenID || "", 48);

  const name =
    safeStr(payload.name || payload.tokenName || payload.collectionName || payload.project || payload.collection || "", 120);

  let display = null;
  if (name && tokenId) display = `🖼️ **NFT:** \`${name} #${tokenId}\``;
  else if (tokenId) display = `🖼️ **NFT:** \`#${tokenId}\``;
  else if (name) display = `🖼️ **NFT:** \`${name}\``;

  const parts = [];
  if (chain) parts.push(`chain: \`${chain}\``);
  if (contract) parts.push(`contract: \`${contract.slice(0, 10)}…${contract.slice(-6)}\``);
  if (tokenId) parts.push(`tokenId: \`${tokenId}\``);

  const meta = parts.length ? `🔎 ${parts.join(" • ")}` : null;
  return { display, meta };
}

async function postWinnerReveal(client, pg, wonGame, winner, guessValue) {
  const guildId = wonGame.guild_id;
  const cfg = await getGiftConfig(pg, guildId).catch(() => null);
  const announceChannelId = cfg?.announce_channel_id || wonGame.channel_id;

  const totalGuesses = Number(wonGame.total_guesses || 0);
  const startedAt = wonGame.started_at ? new Date(wonGame.started_at).getTime() : Date.now();
  const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const uniquePlayers = await computeUniquePlayers(pg, wonGame.id).catch(() => 0);

  try { await pg.query(`UPDATE gift_games SET unique_players=$2 WHERE id=$1`, [wonGame.id, uniquePlayers]); } catch {}

  const revealPrizeText = safeStr(wonGame.prize_label || "Mystery prize 🎁", 220);
  const prizePayload = parsePrizePayload(wonGame);

  const { display: nftDisplayLine, meta: nftMetaLine } =
    (wonGame.prize_type === "nft") ? buildNftDisplayFromPayload(prizePayload) : { display: null, meta: null };

  // Render reveal card
  let attachCard = null;
  let cardName = null;
  let resolvedImageUrl = null;

  if (renderGiftRevealCard) {
    const rr = await renderGiftRevealCard({
      prizeType: wonGame.prize_type,
      prizeLabel: revealPrizeText,
      prizePayload,
      winnerId: winner.id,
      winnerTag: winner.tag || "",
      footer: `Game #${wonGame.id} • ${wonGame.prize_type || "prize"} reveal`,
    }).catch(() => null);

    resolvedImageUrl = rr?.resolvedImageUrl || null;

    if (rr?.buffer) {
      cardName = "gift-card.png";
      attachCard = new AttachmentBuilder(rr.buffer, { name: cardName });
    }
  }

  const winnerEmbed = buildWinnerEmbed({
    game: wonGame,
    winnerId: winner.id,
    winnerTag: winner.tag || null,
    winNum: guessValue,
    elapsedSec,
    totalGuesses,
    uniquePlayers,
    revealPrizeText,
    nftDisplayLine,
    nftMetaLine,
  });

  const canUseDirectImage =
    resolvedImageUrl &&
    !isDataUrl(resolvedImageUrl) &&
    /^https?:\/\//i.test(String(resolvedImageUrl));

  if (canUseDirectImage) {
    winnerEmbed.setImage(resolvedImageUrl);
    if (attachCard && cardName) winnerEmbed.setThumbnail(`attachment://${cardName}`);
  } else {
    if (attachCard && cardName) winnerEmbed.setImage(`attachment://${cardName}`);
  }

  try {
    const ch = await client.channels.fetch(announceChannelId).catch(() => null);
    if (ch) {
      await ch.send({
        embeds: [winnerEmbed],
        files: attachCard ? [attachCard] : [],
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  } catch {}
}

async function endGameWithWinner(client, pg, game, winner, guessRow, hint) {
  const guildId = game.guild_id;
  const gameId = game.id;

  const winUpdate = await pg.query(
    `
    UPDATE gift_games
    SET
      status='ended',
      ended_at=NOW(),
      winner_user_id=$2,
      winner_user_tag=$3,
      winning_guess=$4
    WHERE id=$1 AND status='active'
    RETURNING *;
    `,
    [gameId, winner.id, winner.tag || null, guessRow.guess_value]
  );

  const wonGame = winUpdate.rows?.[0] || null;
  if (!wonGame) return { ok: false, reason: "already_ended" };

  try { await pg.query(`UPDATE gift_guesses SET is_correct=TRUE, hint='correct' WHERE id=$1`, [guessRow.id]); } catch {}
  try { await upsertUserStateOnGuess(pg, { guildId, userId: winner.id, gameId, addWin: true }); } catch {}

  await writeAudit(pg, {
    guild_id: guildId,
    game_id: gameId,
    action: "winner",
    actor_user_id: winner.id,
    actor_tag: winner.tag || null,
    details: { winning_guess: guessRow.guess_value, hint: hint || null }
  });

  setImmediate(async () => {
    try {
      const channel = await client.channels.fetch(game.channel_id).catch(() => null);
      if (channel && game.drop_message_id) {
        const msg = await channel.messages.fetch(game.drop_message_id).catch(() => null);
        if (msg) {
          const endedEmbed = EmbedBuilder.from(msg.embeds?.[0] || {})
            .setTitle("🎁 MYSTERY GIFT DROP — CLOSED")
            .setDescription(
              [
                `✅ Winner found!`,
                `**Winner:** <@${winner.id}>`,
                `**Winning Number:** \`${guessRow.guess_value}\``,
                "",
                `This drop is now closed.`,
              ].join("\n")
            );

          await msg.edit({
            embeds: [endedEmbed],
            components: disableAllComponents(msg.components),
          }).catch(() => {});
        }
      }
    } catch {}

    try { await postWinnerReveal(client, pg, wonGame, winner, guessRow.guess_value); } catch {}
  });

  return { ok: true, game: wonGame };
}

async function expireGame(client, pg, game) {
  const gameId = game.id;

  const upd = await pg.query(
    `
    UPDATE gift_games
    SET status='expired', ended_at=NOW()
    WHERE id=$1 AND status='active'
    RETURNING *;
    `,
    [gameId]
  );

  const expired = upd.rows?.[0] || null;
  if (!expired) return false;

  const uniquePlayers = await computeUniquePlayers(pg, gameId).catch(() => 0);
  try { await pg.query(`UPDATE gift_games SET unique_players=$2 WHERE id=$1`, [gameId, uniquePlayers]); } catch {}

  await writeAudit(pg, {
    guild_id: expired.guild_id,
    game_id: gameId,
    action: "expire",
    actor_user_id: null,
    actor_tag: null,
    details: { reason: "time" }
  });

  setImmediate(async () => {
    try {
      const channel = await client.channels.fetch(expired.channel_id).catch(() => null);
      if (channel && expired.drop_message_id) {
        const msg = await channel.messages.fetch(expired.drop_message_id).catch(() => null);
        if (msg) {
          const expEmbed = EmbedBuilder.from(msg.embeds?.[0] || {})
            .setTitle("🎁 MYSTERY GIFT DROP — EXPIRED")
            .setDescription(
              [
                `⏳ Time ran out. No winner this round.`,
                `**Range:** \`${expired.range_min} → ${expired.range_max}\``,
                "",
                `This drop is now closed.`,
              ].join("\n")
            );

          await msg.edit({
            embeds: [expEmbed],
            components: disableAllComponents(msg.components),
          }).catch(() => {});
        }
      }
    } catch {}
  });

  return true;
}

async function handleGuess(client, interactionOrMessage, { game, guessValue, source, messageId }) {
  const pg = client.pg;
  const guildId = game.guild_id;
  const channelId = game.channel_id;
  const user = interactionOrMessage.user || interactionOrMessage.author;
  const userId = user.id;
  const userTag = user.tag || null;

  if (game.status !== "active") return { ok: false, reason: "not_active" };

  const endsAtMs = game.ends_at ? new Date(game.ends_at).getTime() : null;
  if (endsAtMs && Date.now() > endsAtMs) {
    await expireGame(client, pg, game).catch(() => {});
    return { ok: false, reason: "expired" };
  }

  const rMin = Number(game.range_min);
  const rMax = Number(game.range_max);
  if (!Number.isFinite(rMin) || !Number.isFinite(rMax)) return { ok: false, reason: "bad_range" };
  if (guessValue < rMin || guessValue > rMax) return { ok: false, reason: "out_of_range" };

  const cooldownMs = Number(game.per_user_cooldown_ms || 0);
  const maxGuesses = Number(game.max_guesses_per_user || 25);
  const hintsMode = String(game.hints_mode || "highlow").toLowerCase();

  const state = await getUserState(pg, guildId, userId);
  if (state?.last_guess_at && cooldownMs > 0) {
    const lastMs = new Date(state.last_guess_at).getTime();
    if (Number.isFinite(lastMs) && nowMs() - lastMs < cooldownMs) {
      return { ok: false, reason: "cooldown", waitMs: cooldownMs - (nowMs() - lastMs) };
    }
  }

  const guessesInThisGame =
    state && String(state.last_game_id || "") === String(game.id)
      ? Number(state.guesses_in_game || 0)
      : 0;

  if (maxGuesses > 0 && guessesInThisGame >= maxGuesses) {
    return { ok: false, reason: "max_guesses" };
  }

  const target = Number(game.target_number);
  let hint = "none";
  if (hintsMode === "hotcold") hint = hintHotCold(guessValue, target);
  else if (hintsMode === "highlow") hint = hintHighLow(guessValue, target);
  else hint = guessValue === target ? "correct" : "none";

  const isCorrect = guessValue === target;

  const guessRow = await insertGuess(client.pg, {
    gameId: game.id,
    guildId,
    channelId,
    userId,
    userTag,
    guessValue,
    source,
    messageId,
    isCorrect: false,
    hint: hint === "correct" ? "correct" : hint
  });

  await incrementGameGuessCount(client.pg, game.id);
  await upsertUserStateOnGuess(client.pg, { guildId, userId, gameId: game.id, addWin: false });

  if (isCorrect) {
    const res = await endGameWithWinner(client, client.pg, game, user, guessRow, hint);
    if (!res.ok && res.reason === "already_ended") return { ok: false, reason: "already_ended" };
    return { ok: true, won: true, hint: "correct" };
  }

  return { ok: true, won: false, hint };
}

// ✅ Public response helper
async function respondPublicHint({ client, cfg, message, hint, game }) {
  const mode = String(cfg?.public_hint_mode || "reply").toLowerCase(); // reply | react | both | silent
  const deleteMs = Number(cfg?.public_hint_delete_ms || 0);

  const channel = message.channel;
  const me = message.guild?.members?.me || message.guild?.members?.cache?.get(client.user.id);
  const canSend = channel?.permissionsFor?.(me)?.has?.(PermissionsBitField.Flags.SendMessages);
  const canManage = channel?.permissionsFor?.(me)?.has?.(PermissionsBitField.Flags.ManageMessages);
  const canReact = channel?.permissionsFor?.(me)?.has?.(PermissionsBitField.Flags.AddReactions);

  const reactEmoji = (() => {
    switch (hint) {
      case "too_low": return "🔺";
      case "too_high": return "🔻";
      case "hot": return "🔥";
      case "warm": return "🌡️";
      case "cold": return "🧊";
      case "frozen": return "🥶";
      case "correct": return "🎁";
      default: return null;
    }
  })();

  if ((mode === "react" || mode === "both") && canReact && reactEmoji) {
    message.react(reactEmoji).catch(() => {});
  }

  if ((mode === "reply" || mode === "both") && canSend) {
    const txt = hintToUserText(hint);
    const content =
      hint === "correct"
        ? `🎁 ${txt} **Winner!** Reveal incoming…`
        : `${txt}`;

    const sent = await message.reply({ content, allowedMentions: { parse: [] } }).catch(() => null);

    if (sent && deleteMs > 0 && canManage) {
      setTimeout(() => sent.delete().catch(() => {}), Math.max(1000, deleteMs));
    }
  }
}

// ======================================================
// ✅ Progressive hints (start after 75% time)
// Stages:
// 1 @ >= 75%: parity + wide narrowed band
// 2 @ >= 85%: narrower band
// 3 @ >= 93%: last digit
// ======================================================

function calcBand(target, min, max, fractionSize) {
  const span = Math.max(1, max - min + 1);
  const width = Math.max(10, Math.floor(span * fractionSize));
  let lo = target - Math.floor(width / 2);
  let hi = lo + width;

  if (lo < min) { lo = min; hi = Math.min(max, lo + width); }
  if (hi > max) { hi = max; lo = Math.max(min, hi - width); }
  return { lo, hi };
}

async function maybePostProgressiveHint(client, pg, game, cfg) {
  try {
    if (!cfg?.progressive_hints_enabled) return;

    const startedMs = game.started_at ? new Date(game.started_at).getTime() : null;
    const endsMs = game.ends_at ? new Date(game.ends_at).getTime() : null;
    if (!startedMs || !endsMs) return;

    const total = endsMs - startedMs;
    if (total <= 0) return;

    const elapsed = Date.now() - startedMs;
    const frac = elapsed / total;

    // ✅ only after 75%
    if (frac < 0.75) return;

    const stageNow =
      frac >= 0.93 ? 3 :
      frac >= 0.85 ? 2 :
      1;

    const stageDb = Number(game.hint_stage || 0);
    if (stageNow <= stageDb) return; // already posted

    const target = Number(game.target_number);
    const rMin = Number(game.range_min);
    const rMax = Number(game.range_max);
    if (!Number.isFinite(target) || !Number.isFinite(rMin) || !Number.isFinite(rMax)) return;

    // Build hint content
    let content = null;

    if (stageNow === 1) {
      const parity = (target % 2 === 0) ? "**even**" : "**odd**";
      const band = calcBand(target, rMin, rMax, 0.25);
      content = `🔎 **Hint #1:** The number is ${parity}. Also… it’s somewhere between \`${band.lo}–${band.hi}\`.`;
    } else if (stageNow === 2) {
      const band = calcBand(target, rMin, rMax, 0.12);
      content = `🔎 **Hint #2:** Narrowing in… it’s between \`${band.lo}–${band.hi}\`.`;
    } else if (stageNow === 3) {
      const last = Math.abs(target) % 10;
      content = `🔎 **Final Hint:** The last digit is \`${last}\`.`;
    }

    if (!content) return;

    const channel = await client.channels.fetch(game.channel_id).catch(() => null);
    if (!channel) return;

    const me = channel.guild?.members?.me || channel.guild?.members?.cache?.get(client.user.id);
    const canSend = channel?.permissionsFor?.(me)?.has?.(PermissionsBitField.Flags.SendMessages);
    const canManage = channel?.permissionsFor?.(me)?.has?.(PermissionsBitField.Flags.ManageMessages);
    if (!canSend) return;

    const sent = await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null);

    // Update DB stage to prevent repeats (even after restart)
    await pg.query(
      `UPDATE gift_games SET hint_stage=$2, last_hint_at=NOW() WHERE id=$1`,
      [game.id, stageNow]
    ).catch(() => {});

    await writeAudit(pg, {
      guild_id: game.guild_id,
      game_id: game.id,
      action: "progressive_hint",
      actor_user_id: null,
      actor_tag: null,
      details: { stage: stageNow }
    });

    // Optional auto-delete
    const del = Number(cfg?.progressive_hint_delete_ms || 0);
    if (sent && del > 0 && canManage) {
      setTimeout(() => sent.delete().catch(() => {}), Math.max(1000, del));
    }
  } catch (e) {
    if (DEBUG) console.warn("⚠️ [GIFT] progressive hint error:", e?.message || e);
  }
}

module.exports = (client) => {
  const EXPIRY_TICK_MS = Number(process.env.GIFT_EXPIRY_TICK_MS || 20000);

  setInterval(async () => {
    try {
      const pg = client.pg;
      if (!pg?.query) return;
      if (!(await ensureSchemaIfNeeded(client))) return;

      // ✅ ensure hint columns exist
      await ensureGiftGamesHintColumns(pg);

      // 1) Expire games
      const exp = await pg.query(
        `
        SELECT * FROM gift_games
        WHERE status='active' AND ends_at IS NOT NULL AND ends_at < NOW()
        ORDER BY ends_at ASC
        LIMIT 10
        `
      );

      const expGames = exp.rows || [];
      for (const g of expGames) {
        await expireGame(client, pg, g).catch(() => {});
      }

      // 2) Progressive hints for active games (near end)
      const act = await pg.query(
        `
        SELECT * FROM gift_games
        WHERE status='active' AND ends_at IS NOT NULL AND started_at IS NOT NULL
        ORDER BY started_at DESC
        LIMIT 25
        `
      );

      const activeGames = act.rows || [];
      for (const g of activeGames) {
        const cfg = await getGiftConfig(pg, g.guild_id).catch(() => null);
        if (!cfg) continue;
        await maybePostProgressiveHint(client, pg, g, cfg);
      }
    } catch (e) {
      if (DEBUG) console.warn("⚠️ [GIFT] tick error:", e?.message || e);
    }
  }, Math.max(5000, EXPIRY_TICK_MS));

  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction?.guildId) return;
      const pg = client.pg;
      if (!pg?.query) return;
      if (!(await ensureSchemaIfNeeded(client))) return;

      if (interaction.isButton()) {
        const cid = String(interaction.customId || "");
        if (!cid.startsWith("gift_")) return;

        const [head, gameIdRaw] = cid.split(":");
        const gameId = Number(gameIdRaw);
        if (!Number.isFinite(gameId)) {
          return interaction.reply({ content: "❌ Invalid game id.", ephemeral: true }).catch(() => {});
        }

        const game = await getGiftGameById(pg, gameId);
        if (!game) return interaction.reply({ content: "❌ Game not found.", ephemeral: true }).catch(() => {});

        if (head === "gift_guess") {
          if (String(game.mode || "").toLowerCase() !== "modal") {
            return interaction.reply({ content: "This game is not using modal mode. Type guesses in chat instead.", ephemeral: true }).catch(() => {});
          }
          if (game.status !== "active") {
            return interaction.reply({ content: "This drop is already closed.", ephemeral: true }).catch(() => {});
          }

          const modal = new ModalBuilder()
            .setCustomId(`gift_guess_modal:${gameId}`)
            .setTitle("🎁 Guess the Secret Number");

          const input = new TextInputBuilder()
            .setCustomId("gift_number")
            .setLabel(`Enter a number (${game.range_min}–${game.range_max})`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(12);

          const row = new ActionRowBuilder().addComponents(input);
          modal.addComponents(row);

          return interaction.showModal(modal).catch(() => {});
        }

        if (head === "gift_rules") {
          const endsAt = game.ends_at ? `<t:${Math.floor(new Date(game.ends_at).getTime() / 1000)}:R>` : "N/A";
          const prizeLine = game.prize_secret ? "??? (revealed on win)" : (game.prize_label || "Mystery prize 🎁");

          const embed = new EmbedBuilder()
            .setTitle("📜 Gift Drop Rules")
            .setDescription(
              [
                `**Range:** \`${game.range_min} → ${game.range_max}\``,
                `**Mode:** \`${game.mode}\``,
                `**Ends:** ${endsAt}`,
                `**Prize:** ${prizeLine}`,
                "",
                `✅ First person to guess the number wins instantly.`,
                `⏱ Cooldown: \`${game.per_user_cooldown_ms}ms\``,
                `🎯 Max guesses/user: \`${game.max_guesses_per_user}\``,
                `🧠 Hints: \`${game.hints_mode}\``,
                "",
                game.mode === "modal"
                  ? `Use the **Guess** button to submit (no spam).`
                  : `Type your number in chat (example: \`42\`).`
              ].join("\n")
            )
            .setFooter({ text: `Game ID: ${game.id}` });

          return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
        }

        if (head === "gift_stats") {
          const state = await getUserState(pg, interaction.guildId, interaction.user.id);
          const guessesInThisGame =
            state && String(state.last_game_id || "") === String(game.id)
              ? Number(state.guesses_in_game || 0)
              : 0;

          const embed = new EmbedBuilder()
            .setTitle("📊 Your Gift Stats")
            .addFields(
              { name: "Guesses (this game)", value: `\`${guessesInThisGame}\` / \`${game.max_guesses_per_user}\``, inline: true },
              { name: "Wins (all-time)", value: `\`${Number(state?.wins_total || 0)}\``, inline: true },
              { name: "Guesses (all-time)", value: `\`${Number(state?.guesses_total || 0)}\``, inline: true }
            )
            .setFooter({ text: `Game ID: ${game.id}` });

          return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
        }

        return;
      }

      if (interaction.isModalSubmit()) {
        const cid = String(interaction.customId || "");
        if (!cid.startsWith("gift_guess_modal:")) return;

        // ✅ ACK IMMEDIATELY
        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        const gameId = Number(cid.split(":")[1]);
        if (!Number.isFinite(gameId)) return interaction.editReply("❌ Invalid game id.").catch(() => {});

        const game = await getGiftGameById(pg, gameId);
        if (!game) return interaction.editReply("❌ Game not found.").catch(() => {});
        if (game.status !== "active") return interaction.editReply("This drop is already closed.").catch(() => {});
        if (String(game.mode || "").toLowerCase() !== "modal") {
          return interaction.editReply("This game is not in modal mode.").catch(() => {});
        }

        const val = interaction.fields.getTextInputValue("gift_number");
        const guessValue = intFromText(val);
        if (guessValue === null) return interaction.editReply("❌ Please enter a whole number.").catch(() => {});

        const res = await handleGuess(client, interaction, { game, guessValue, source: "modal", messageId: null });

        if (!res.ok) {
          if (res.reason === "cooldown") {
            const s = Math.ceil((res.waitMs || 0) / 1000);
            return interaction.editReply(`⏳ Cooldown. Try again in ~${s}s.`).catch(() => {});
          }
          if (res.reason === "max_guesses") return interaction.editReply(`⛔ You reached the max guesses for this game.`).catch(() => {});
          if (res.reason === "out_of_range") return interaction.editReply(`❌ Out of range. Use \`${game.range_min}–${game.range_max}\`.`).catch(() => {});
          if (res.reason === "already_ended") return interaction.editReply(`⚠️ Too late — someone already won.`).catch(() => {});
          if (res.reason === "expired") return interaction.editReply(`⏳ This drop already expired.`).catch(() => {});
          return interaction.editReply(`❌ Guess not accepted (${res.reason}).`).catch(() => {});
        }

        if (res.won) return interaction.editReply(`🎁 ${hintToUserText("correct")} Winner announcement posted!`).catch(() => {});
        return interaction.editReply(hintToUserText(res.hint)).catch(() => {});
      }
    } catch (e) {
      if (DEBUG) console.warn("⚠️ [GIFT] interaction handler error:", e?.message || e);
    }
  });

  client.on("messageCreate", async (message) => {
    try {
      if (!message?.guildId) return;
      if (message.author?.bot) return;

      const pg = client.pg;
      if (!pg?.query) return;
      if (!(await ensureSchemaIfNeeded(client))) return;

      const guessValue = intFromText(message.content);
      if (guessValue === null) return;

      const game = await getActiveGiftGameInChannel(pg, message.guildId, message.channelId);
      if (!game) return;
      if (String(game.mode || "").toLowerCase() !== "public") return;

      const cfg = await getGiftConfig(pg, message.guildId).catch(() => null);

      const res = await handleGuess(client, message, { game, guessValue, source: "public", messageId: message.id });

      // Optional out-of-range feedback
      if (!res.ok && res.reason === "out_of_range") {
        if (cfg?.public_out_of_range_feedback) {
          const me = message.guild?.members?.me || message.guild?.members?.cache?.get(client.user.id);
          const canSend = message.channel?.permissionsFor?.(me)?.has?.(PermissionsBitField.Flags.SendMessages);
          const canManage = message.channel?.permissionsFor?.(me)?.has?.(PermissionsBitField.Flags.ManageMessages);
          if (canSend) {
            const sent = await message.reply({
              content: `⚠️ Out of range. Use \`${game.range_min}-${game.range_max}\`.`,
              allowedMentions: { parse: [] }
            }).catch(() => null);
            const del = Number(cfg?.public_hint_delete_ms || 0);
            if (sent && del > 0 && canManage) setTimeout(() => sent.delete().catch(() => {}), Math.max(1000, del));
          }
        }
        return;
      }

      if (!res.ok) return;

      if (res.won) {
        await respondPublicHint({ client, cfg, message, hint: "correct", game }).catch(() => {});
        return;
      }

      await respondPublicHint({ client, cfg, message, hint: res.hint, game }).catch(() => {});
    } catch (e) {
      if (DEBUG) console.warn("⚠️ [GIFT] message handler error:", e?.message || e);
    }
  });

  console.log("✅ GiftGameListener loaded (public replies + progressive hints after 75%)");
};

