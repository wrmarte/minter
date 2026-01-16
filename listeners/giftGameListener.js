// listeners/giftGameListener.js
// ======================================================
// Gift Drop Guess Game — Runtime Engine + Wizard UI
// PATCH:
// ✅ Fix "Interaction failed" on NFT/Role/Token buttons by showing modal IMMEDIATELY (no DB before showModal)
// ✅ FIX: Discord TextInput label limit is 45 chars — shorten long labels (NFT image + role duration)
// ✅ NEW: Public mode cooldown enforcement:
//    - If user posts guess too fast -> delete their number message (if possible)
//    - Warn user with wait time (auto-delete warning)
// ✅ Use flags: 64 instead of ephemeral (deprecation warning)
// ✅ NEW: Winner/reveal GIF for TEXT + ROLE prizes (fits: uses embed IMAGE)
// ✅ Keeps public + modal gameplay, winner reveal, audit writes
// ======================================================

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
  ChannelType,
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

// Default thumbnail (general reveal)
const GIFT_REVEAL_GIF =
  (process.env.GIFT_REVEAL_GIF || "").trim() ||
  "https://media.giphy.com/media/3o6Zt481isNVuQI1l6/giphy.gif";

// ✅ NEW: large “fits” GIF for TEXT + ROLE wins (embed image)
const GIFT_TEXT_ROLE_REVEAL_GIF =
  (process.env.GIFT_TEXT_ROLE_REVEAL_GIF || "").trim() ||
  "https://iili.io/fSwz7EJ.gif";

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

function looksLikeAddress(a) {
  const s = String(a || "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function normalizeChain(c) {
  const s = String(c || "").trim().toLowerCase();
  if (!s) return "base";
  if (s === "eth" || s === "ethereum" || s.includes("mainnet")) return "eth";
  if (s === "base") return "base";
  if (s === "ape" || s.includes("ape")) return "ape";
  return s;
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

async function getGiftConfig(pg, guildId) {
  // NOTE: keep a row per guild; but don't swallow silently in debug
  await pg.query(
    `INSERT INTO gift_config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`,
    [guildId]
  ).catch((e) => {
    if (DEBUG) console.warn("⚠️ [GIFT] getGiftConfig upsert failed:", e?.message || e);
  });

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

function makeCleanDropEmbed(game) {
  const endsTs = game.ends_at ? Math.floor(new Date(game.ends_at).getTime() / 1000) : null;
  const startedTs = game.started_at ? Math.floor(new Date(game.started_at).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const dur = endsTs ? Math.max(10, endsTs - startedTs) : 600;
  const hintsUnlockTs = startedTs + Math.floor(dur * 0.75);

  const prizeLine =
    game.prize_secret
      ? "??? (reveals when someone wins)"
      : (game.prize_label || "Mystery prize 🎁");

  const lines = [
    `A gift is floating in the chat… **guess the secret number** to claim it.`,
    ``,
    `**Range:** \`${game.range_min} → ${game.range_max}\``,
    `**Time Left:** ${endsTs ? `<t:${endsTs}:R>` : "N/A"}`,
    `**Hints unlock:** <t:${hintsUnlockTs}:R> (after 75% time)`,
    `**Cooldown:** \`${game.per_user_cooldown_ms}ms\` • **Max:** \`${game.max_guesses_per_user}\``,
    `**Mode:** \`${game.mode}\` • **Hints:** \`${game.hints_mode}\``,
    ``,
    `**Prize:** ${prizeLine}`,
    game.commit_enabled ? `**Fairness:** commit hash locked ✅` : `**Fairness:** standard`,
    ``,
    String(game.mode || "").toLowerCase() === "modal"
      ? `Click **🎯 Guess** (no chat spam).`
      : `Type your guess as a number in this channel (example: \`42\`).`,
  ];

  return new EmbedBuilder()
    .setTitle("🎁 GIFT DROP LIVE")
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Game ID: ${game.id}` });
}

async function attachDropMessage(pg, { gameId, messageId, messageUrl }) {
  await pg.query(
    `UPDATE gift_games SET drop_message_id=$1, drop_message_url=$2 WHERE id=$3`,
    [String(messageId), messageUrl || null, gameId]
  );
}

// Draft prize save
async function updateDraftPrize(pg, gameId, { prize_type, prize_label, prize_payload }) {
  const r = await pg.query(
    `
    UPDATE gift_games
    SET prize_type=$2, prize_label=$3, prize_payload=$4
    WHERE id=$1 AND status='draft'
    RETURNING *;
    `,
    [gameId, prize_type, prize_label, prize_payload ? JSON.stringify(prize_payload) : null]
  );
  return r.rows?.[0] || null;
}

// Launch draft -> active
async function launchDraftGame(pg, gameId) {
  const r = await pg.query(
    `
    UPDATE gift_games
    SET status='active'
    WHERE id=$1 AND status='draft'
    RETURNING *;
    `,
    [gameId]
  );
  return r.rows?.[0] || null;
}

// Cancel draft
async function cancelDraftGame(pg, gameId) {
  const r = await pg.query(
    `
    UPDATE gift_games
    SET status='cancelled', ended_at=NOW()
    WHERE id=$1 AND status='draft'
    RETURNING *;
    `,
    [gameId]
  );
  return r.rows?.[0] || null;
}

// ===============================
// Winner reveal helpers
// ===============================
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
    .setDescription(lines.join("\n"));

  // NOTE: image/thumbnail is decided later in postWinnerReveal() so we can "fit" the right GIF.
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

  const name = safeStr(payload.name || payload.collectionName || payload.collection || "", 120);

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

  let attachCard = null;
  let cardName = null;
  let resolvedImageUrl = null;

  // Renderer may produce a nice PNG card (keep it)
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

  const prizeType = String(wonGame.prize_type || "").toLowerCase();
  const canUseDirectImage =
    resolvedImageUrl &&
    !isDataUrl(resolvedImageUrl) &&
    /^https?:\/\//i.test(String(resolvedImageUrl));

  // ✅ NEW: TEXT + ROLE uses big GIF as IMAGE (fits)
  if (prizeType === "text" || prizeType === "role") {
    winnerEmbed.setImage(GIFT_TEXT_ROLE_REVEAL_GIF);

    // If we also have a rendered card, put it as thumbnail so we still keep the custom look
    if (attachCard && cardName) {
      winnerEmbed.setThumbnail(`attachment://${cardName}`);
    } else if (canUseDirectImage) {
      // fallback thumbnail if renderer gave a URL only
      winnerEmbed.setThumbnail(resolvedImageUrl);
    } else {
      // generic fallback thumbnail
      winnerEmbed.setThumbnail(GIFT_REVEAL_GIF);
    }
  } else {
    // Default behavior for NFT/token/etc
    winnerEmbed.setThumbnail(GIFT_REVEAL_GIF);

    if (canUseDirectImage) {
      winnerEmbed.setImage(resolvedImageUrl);
      if (attachCard && cardName) winnerEmbed.setThumbnail(`attachment://${cardName}`);
    } else {
      if (attachCard && cardName) winnerEmbed.setImage(`attachment://${cardName}`);
    }
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
            .setTitle("🎁 GIFT DROP — CLOSED")
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
            .setTitle("🎁 GIFT DROP — EXPIRED")
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

  const guessRow = await insertGuess(pg, {
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

  await incrementGameGuessCount(pg, game.id);
  await upsertUserStateOnGuess(pg, { guildId, userId, gameId: game.id, addWin: false });

  if (isCorrect) {
    const res = await endGameWithWinner(client, pg, game, user, guessRow, hint);
    if (!res.ok && res.reason === "already_ended") return { ok: false, reason: "already_ended" };
    return { ok: true, won: true, hint: "correct" };
  }

  return { ok: true, won: false, hint };
}

// Public response helper
async function respondPublicHint({ client, cfg, message, hint, game }) {
  const mode = String(cfg?.public_hint_mode || "reply").toLowerCase(); // reply | react | both | silent
  const deleteMs = Number(cfg?.public_hint_delete_ms || 0);
  const replyToUser = Number(cfg?.public_hint_only_if_reply_to_user ?? 1) === 1;

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
        ? `🎁 ${txt} Winner announcement incoming…`
        : `${txt} (range \`${game.range_min}-${game.range_max}\`)`;

    const sent = await (replyToUser
      ? message.reply({ content, allowedMentions: { parse: [] } })
      : channel.send({ content, allowedMentions: { parse: [] } })
    ).catch(() => null);

    if (sent && deleteMs > 0 && canManage) {
      setTimeout(() => sent.delete().catch(() => {}), Math.max(1000, deleteMs));
    }
  }
}

// ✅ Public cooldown / reject handler (delete guess + warn user)
async function handlePublicReject({ client, cfg, message, game, reason, waitMs }) {
  try {
    const channel = message.channel;
    const me = message.guild?.members?.me || message.guild?.members?.cache?.get(client.user.id);

    const canSend = channel?.permissionsFor?.(me)?.has?.(PermissionsBitField.Flags.SendMessages);
    const canManage = channel?.permissionsFor?.(me)?.has?.(PermissionsBitField.Flags.ManageMessages);

    const deleteGuessOnCooldown = Number(cfg?.public_cooldown_delete_guess ?? 1) === 1;
    const warnOnCooldown = Number(cfg?.public_cooldown_warn ?? 1) === 1;
    const warnDeleteMs = Number(cfg?.public_cooldown_warn_delete_ms ?? 5000);

    // Delete the user's guess message if we can
    if (reason === "cooldown" && deleteGuessOnCooldown && canManage) {
      await message.delete().catch(() => {});
    }

    // Warn user
    if (reason === "cooldown" && warnOnCooldown && canSend) {
      const s = Math.max(1, Math.ceil(Number(waitMs || 0) / 1000));
      const warn = await channel
        .send({
          content: `⏳ <@${message.author.id}> slow down — wait ~${s}s before guessing again.`,
          allowedMentions: { users: [message.author.id] },
        })
        .catch(() => null);

      if (warn && warnDeleteMs > 0 && canManage) {
        setTimeout(() => warn.delete().catch(() => {}), Math.max(1500, warnDeleteMs));
      }
    }

    // Optional: max guesses warning
    if (reason === "max_guesses" && canSend) {
      const warn = await channel
        .send({
          content: `⛔ <@${message.author.id}> you reached the max guesses for this drop.`,
          allowedMentions: { users: [message.author.id] },
        })
        .catch(() => null);

      if (warn && canManage) {
        setTimeout(() => warn.delete().catch(() => {}), 5000);
      }
    }
  } catch {}
}

module.exports = (client) => {
  const EXPIRY_TICK_MS = Number(process.env.GIFT_EXPIRY_TICK_MS || 20000);

  setInterval(async () => {
    try {
      const pg = client.pg;
      if (!pg?.query) return;
      if (!(await ensureSchemaIfNeeded(client))) return;

      const r = await pg.query(
        `
        SELECT * FROM gift_games
        WHERE status='active' AND ends_at IS NOT NULL AND ends_at < NOW()
        ORDER BY ends_at ASC
        LIMIT 10
        `
      );

      const games = r.rows || [];
      if (!games.length) return;

      for (const g of games) {
        await expireGame(client, pg, g).catch(() => {});
      }
    } catch (e) {
      if (DEBUG) console.warn("⚠️ [GIFT] expiry tick error:", e?.message || e);
    }
  }, Math.max(5000, EXPIRY_TICK_MS));

  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction?.guildId) return;
      const pg = client.pg;
      if (!pg?.query) return;
      if (!(await ensureSchemaIfNeeded(client))) return;

      // =========================
      // BUTTONS
      // =========================
      if (interaction.isButton()) {
        const cid = String(interaction.customId || "");

        // ✅ FIX: Wizard pick buttons must show modal immediately (NO DB BEFORE showModal)
        if (cid.startsWith("gift_wiz_pick:")) {
          // Optional quick permission gate (fast, no DB)
          const allowed =
            interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ||
            interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);

          if (!allowed) {
            return interaction.reply({
              content: "⛔ Only admins / Manage Server can configure a gift drop.",
              flags: 64,
            }).catch(() => {});
          }

          const parts = cid.split(":");
          const gameId = Number(parts[1]);
          const prizeType = String(parts[2] || "").toLowerCase();

          if (!Number.isFinite(gameId)) {
            return interaction.reply({ content: "❌ Invalid draft id.", flags: 64 }).catch(() => {});
          }

          // Build modal (NO DB)
          const modal = new ModalBuilder()
            .setCustomId(`gift_wiz_prize_modal:${gameId}:${prizeType}`)
            .setTitle(`Gift Prize — ${prizeType.toUpperCase()}`);

          const rows = [];

          if (prizeType === "nft") {
            const name = new TextInputBuilder()
              .setCustomId("nft_name")
              .setLabel("Collection / Project (ex: CryptoPimps)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(80);

            const ca = new TextInputBuilder()
              .setCustomId("nft_ca")
              .setLabel("Contract address (0x...)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(60);

            const tokenId = new TextInputBuilder()
              .setCustomId("nft_tokenid")
              .setLabel("Token ID (ex: 123)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(30);

            const chain = new TextInputBuilder()
              .setCustomId("nft_chain")
              .setLabel("Chain (base / eth / ape)")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(12);

            // ✅ label shortened (<=45)
            const imageUrl = new TextInputBuilder()
              .setCustomId("nft_image")
              .setLabel("Image URL (optional; blank = auto)")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(300);

            rows.push(
              new ActionRowBuilder().addComponents(name),
              new ActionRowBuilder().addComponents(ca),
              new ActionRowBuilder().addComponents(tokenId),
              new ActionRowBuilder().addComponents(chain),
              new ActionRowBuilder().addComponents(imageUrl),
            );
          } else if (prizeType === "token") {
            const amount = new TextInputBuilder()
              .setCustomId("tok_amount")
              .setLabel("Amount (ex: 50000)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(32);

            const symbol = new TextInputBuilder()
              .setCustomId("tok_symbol")
              .setLabel("Symbol (ex: ADRIAN)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(16);

            const ca = new TextInputBuilder()
              .setCustomId("tok_ca")
              .setLabel("Token contract (0x...) (optional)")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(60);

            const chain = new TextInputBuilder()
              .setCustomId("tok_chain")
              .setLabel("Chain (base / eth / ape)")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(12);

            const logo = new TextInputBuilder()
              .setCustomId("tok_logo")
              .setLabel("Optional logo URL (blank = default)")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(300);

            rows.push(
              new ActionRowBuilder().addComponents(amount),
              new ActionRowBuilder().addComponents(symbol),
              new ActionRowBuilder().addComponents(ca),
              new ActionRowBuilder().addComponents(chain),
              new ActionRowBuilder().addComponents(logo),
            );
          } else if (prizeType === "role") {
            const roleName = new TextInputBuilder()
              .setCustomId("role_name")
              .setLabel("Role name (exact)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(80);

            // ✅ label shortened (<=45)
            const duration = new TextInputBuilder()
              .setCustomId("role_duration")
              .setLabel("Duration (optional: 7d, 24h)")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setMaxLength(20);

            rows.push(
              new ActionRowBuilder().addComponents(roleName),
              new ActionRowBuilder().addComponents(duration),
            );
          } else {
            const text = new TextInputBuilder()
              .setCustomId("text_prize")
              .setLabel("Prize text (ex: WL spot, 1 free mint)")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(400);
            rows.push(new ActionRowBuilder().addComponents(text));
          }

          for (const r of rows) modal.addComponents(r);

          // ✅ showModal immediately
          return interaction.showModal(modal).catch((e) => {
            if (DEBUG) console.warn("⚠️ [GIFT] showModal failed:", e?.message || e);
          });
        }

        // cancel draft (DB ok because we deferReply)
        if (cid.startsWith("gift_wiz_cancel:")) {
          await interaction.deferReply({ flags: 64 }).catch(() => {});
          const gameId = Number(cid.split(":")[1]);
          if (!Number.isFinite(gameId)) return interaction.editReply("❌ Invalid draft id.").catch(() => {});

          const g = await cancelDraftGame(pg, gameId).catch(() => null);

          await writeAudit(pg, {
            guild_id: interaction.guildId,
            game_id: gameId,
            action: "draft_cancelled",
            actor_user_id: interaction.user.id,
            actor_tag: interaction.user.tag,
            details: {}
          });

          return interaction.editReply(g ? `🛑 Draft \`${gameId}\` cancelled.` : `⚠️ Draft not found or already handled.`).catch(() => {});
        }

        // launch draft -> active + post drop
        if (cid.startsWith("gift_wiz_launch:")) {
          await interaction.deferReply({ flags: 64 }).catch(() => {});
          const gameId = Number(cid.split(":")[1]);
          if (!Number.isFinite(gameId)) return interaction.editReply("❌ Invalid draft id.").catch(() => {});

          const draft = await getGiftGameById(pg, gameId).catch(() => null);
          if (!draft || String(draft.guild_id) !== String(interaction.guildId)) {
            return interaction.editReply("❌ Draft not found.").catch(() => {});
          }
          if (String(draft.status || "").toLowerCase() !== "draft") {
            return interaction.editReply("⚠️ Draft already launched / not editable.").catch(() => {});
          }

          const launched = await launchDraftGame(pg, gameId).catch(() => null);
          if (!launched) return interaction.editReply("❌ Failed to launch draft.").catch(() => {});

          const channel = await client.channels.fetch(launched.channel_id).catch(() => null);
          if (!channel || channel.type !== ChannelType.GuildText) {
            return interaction.editReply("❌ Could not fetch the game channel to post the drop.").catch(() => {});
          }

          const embed = makeCleanDropEmbed(launched);

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`gift_guess:${launched.id}`)
              .setLabel("Guess")
              .setEmoji("🎯")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(String(launched.mode || "").toLowerCase() !== "modal"),
            new ButtonBuilder()
              .setCustomId(`gift_rules:${launched.id}`)
              .setLabel("Rules")
              .setEmoji("📜")
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(`gift_stats:${launched.id}`)
              .setLabel("Stats")
              .setEmoji("📊")
              .setStyle(ButtonStyle.Secondary),
          );

          const dropMsg = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
          if (dropMsg?.id) {
            const url = `https://discord.com/channels/${launched.guild_id}/${launched.channel_id}/${dropMsg.id}`;
            await attachDropMessage(pg, { gameId: launched.id, messageId: dropMsg.id, messageUrl: url }).catch(() => {});
          }

          await writeAudit(pg, {
            guild_id: interaction.guildId,
            game_id: launched.id,
            action: "launched",
            actor_user_id: interaction.user.id,
            actor_tag: interaction.user.tag,
            details: { channel_id: launched.channel_id }
          });

          return interaction.editReply(`✅ Launched Gift Drop in <#${launched.channel_id}> (gameId: \`${launched.id}\`).`).catch(() => {});
        }

        // Existing gameplay buttons
        if (cid.startsWith("gift_")) {
          const [head, gameIdRaw] = cid.split(":");
          const gameId = Number(gameIdRaw);
          if (!Number.isFinite(gameId)) {
            return interaction.reply({ content: "❌ Invalid game id.", flags: 64 }).catch(() => {});
          }

          const game = await getGiftGameById(pg, gameId).catch(() => null);
          if (!game) return interaction.reply({ content: "❌ Game not found.", flags: 64 }).catch(() => {});

          if (head === "gift_guess") {
            if (String(game.mode || "").toLowerCase() !== "modal") {
              return interaction.reply({ content: "This game is not using modal mode. Type guesses in chat instead.", flags: 64 }).catch(() => {});
            }
            if (game.status !== "active") {
              return interaction.reply({ content: "This drop is already closed.", flags: 64 }).catch(() => {});
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

            return interaction.reply({ embeds: [embed], flags: 64 }).catch(() => {});
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

            return interaction.reply({ embeds: [embed], flags: 64 }).catch(() => {});
          }

          return;
        }
      }

      // =========================
      // MODALS
      // =========================
      if (interaction.isModalSubmit()) {
        const cid = String(interaction.customId || "");

        // Wizard prize modal submit (safe to do DB because we can deferReply)
        if (cid.startsWith("gift_wiz_prize_modal:")) {
          await interaction.deferReply({ flags: 64 }).catch(() => {});

          const parts = cid.split(":");
          const gameId = Number(parts[1]);
          const prizeType = String(parts[2] || "").toLowerCase();

          if (!Number.isFinite(gameId)) return interaction.editReply("❌ Invalid draft id.").catch(() => {});

          const draft = await getGiftGameById(pg, gameId).catch(() => null);
          if (!draft || String(draft.guild_id) !== String(interaction.guildId)) {
            return interaction.editReply("❌ Draft not found.").catch(() => {});
          }
          if (String(draft.status || "").toLowerCase() !== "draft") {
            return interaction.editReply("⚠️ Draft already launched / not editable.").catch(() => {});
          }

          let prize_label = "Mystery prize 🎁";
          let prize_payload = {};

          if (prizeType === "nft") {
            const name = safeStr(interaction.fields.getTextInputValue("nft_name"), 90);
            const ca = safeStr(interaction.fields.getTextInputValue("nft_ca"), 60);
            const tokenId = safeStr(interaction.fields.getTextInputValue("nft_tokenid"), 40);
            const chain = normalizeChain(safeStr(interaction.fields.getTextInputValue("nft_chain") || "base", 12));
            const img = safeStr(interaction.fields.getTextInputValue("nft_image") || "", 300);

            if (!looksLikeAddress(ca)) return interaction.editReply("❌ Contract must be a valid 0x address.").catch(() => {});
            if (!tokenId) return interaction.editReply("❌ Token ID required.").catch(() => {});

            prize_label = `${name} #${tokenId}`;
            prize_payload = { type: "nft", name, contract: ca, tokenId, chain };
            if (img) prize_payload.image = img;
          } else if (prizeType === "token") {
            const amount = safeStr(interaction.fields.getTextInputValue("tok_amount"), 40);
            const symbol = safeStr(interaction.fields.getTextInputValue("tok_symbol"), 16).toUpperCase();
            const ca = safeStr(interaction.fields.getTextInputValue("tok_ca") || "", 60);
            const chain = normalizeChain(safeStr(interaction.fields.getTextInputValue("tok_chain") || "base", 12));
            const logo = safeStr(interaction.fields.getTextInputValue("tok_logo") || "", 300);

            prize_label = `${amount} $${symbol}`;
            prize_payload = { type: "token", amount, symbol, chain };
            if (looksLikeAddress(ca)) prize_payload.contract = ca;
            if (logo) prize_payload.logoUrl = logo;
          } else if (prizeType === "role") {
            const roleName = safeStr(interaction.fields.getTextInputValue("role_name"), 80);
            const duration = safeStr(interaction.fields.getTextInputValue("role_duration") || "", 30);
            prize_label = duration ? `${roleName} (${duration})` : roleName;
            prize_payload = { type: "role", roleName, duration: duration || null };
          } else {
            const text = safeStr(interaction.fields.getTextInputValue("text_prize"), 400);
            prize_label = text;
            prize_payload = { type: "text", text };
          }

          const saved = await updateDraftPrize(pg, gameId, {
            prize_type: prizeType,
            prize_label,
            prize_payload
          });

          await writeAudit(pg, {
            guild_id: interaction.guildId,
            game_id: gameId,
            action: "wizard_prize_saved",
            actor_user_id: interaction.user.id,
            actor_tag: interaction.user.tag,
            details: { prizeType, prize_label }
          });

          const endsTs = saved?.ends_at ? Math.floor(new Date(saved.ends_at).getTime() / 1000) : null;

          const embed = new EmbedBuilder()
            .setTitle("✅ Gift Drop Ready — Launch It")
            .setDescription(
              [
                `**Draft Game ID:** \`${gameId}\``,
                `**Channel:** <#${saved.channel_id}>`,
                `**Mode:** \`${saved.mode}\``,
                `**Range:** \`${saved.range_min} → ${saved.range_max}\``,
                `**Ends:** ${endsTs ? `<t:${endsTs}:R>` : "N/A"}`,
                `**Prize:** ${saved.prize_secret ? "??? (hidden)" : `\`${prize_label}\``}`,
                `**Prize Type:** \`${prizeType}\``,
                saved.commit_enabled ? `**Fairness:** commit hash locked ✅` : `**Fairness:** standard`,
              ].join("\n")
            )
            .setFooter({ text: "Click Launch to post the clean drop card into the game channel." });

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`gift_wiz_launch:${gameId}`).setLabel("Launch Drop").setEmoji("🚀").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`gift_wiz_pick:${gameId}:${prizeType}`).setLabel("Edit Prize").setEmoji("✏️").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`gift_wiz_cancel:${gameId}`).setLabel("Cancel").setEmoji("❌").setStyle(ButtonStyle.Danger),
          );

          return interaction.editReply({ embeds: [embed], components: [row] }).catch(() => {});
        }

        // Gameplay guess modal
        if (cid.startsWith("gift_guess_modal:")) {
          await interaction.deferReply({ flags: 64 }).catch(() => {});

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

      // cooldown enforcement in public mode
      if (!res.ok) {
        if (res.reason === "cooldown" || res.reason === "max_guesses") {
          await handlePublicReject({
            client,
            cfg,
            message,
            game,
            reason: res.reason,
            waitMs: res.waitMs || 0
          }).catch(() => {});
        }
        return;
      }

      if (res.won) {
        await respondPublicHint({ client, cfg, message, hint: "correct", game }).catch(() => {});
        return;
      }

      await respondPublicHint({ client, cfg, message, hint: res.hint, game }).catch(() => {});
    } catch (e) {
      if (DEBUG) console.warn("⚠️ [GIFT] message handler error:", e?.message || e);
    }
  });

  console.log("✅ GiftGameListener loaded (wizard modal fast-path + label-limit fix + public cooldown delete+warn + flags:64 + text/role win gif)");
};

