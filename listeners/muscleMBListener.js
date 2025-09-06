const fetch = require('node-fetch');
const { EmbedBuilder, ChannelType, PermissionsBitField } = require('discord.js');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const cooldown = new Set();
const TRIGGERS = ['musclemb', 'muscle mb', 'yo mb', 'mbbot', 'mb bro', 'mb', 'hey mb'];

/** ===== Activity tracker for periodic nice messages ===== */
const lastActiveByUser = new Map(); // key: `${guildId}:${userId}` -> { ts, channelId }
const lastNicePingByGuild = new Map(); // guildId -> ts
const NICE_PING_EVERY_MS = 4 * 60 * 60 * 1000; // 4 hours
const NICE_SCAN_EVERY_MS = 60 * 60 * 1000;     // scan hourly
const NICE_ACTIVE_WINDOW_MS = 45 * 60 * 1000;  // “active” = last 45 minutes

// Expanded, punchier lines. Kept original vibes, added variety & micro-coaching.
const NICE_LINES = [
  "hydrate, hustle, and be kind today 💧💪",
  "tiny reps compound. keep going, legend ✨",
  "your pace > perfect. 1% better is a W 📈",
  "posture check, water sip, breathe deep 🧘‍♂️",
  "you’re doing great. send a W to someone else too 🙌",
  "breaks are part of the grind — reset, then rip ⚡️",
  "stack small dubs; the big ones follow 🧱",
  "five deep breaths, then one brave action 🌬️➡️",
  "skip the scroll, ship the thing 📦",
  "water, walk, win — in that order 🚶‍♂️",
  "write it down, knock it out, fist bump later ✍️👊",
  "when in doubt, do the 2-minute version ⏱️",
  "protect your morning; own your evening ☀️🌙",
  "comparison is a trap — focus your lane 🛣️",
  "be the calm in your chat today 🌊",
  "ask a better question, get a better result ❓➡️🏆",
  "show up messy, then refine 🧽",
  "your future self is watching — impress ’em 👀",
  "if it scares you a little, it’s probably right 🗺️",
  "mood follows motion — move first 🕺",
];

// Flavor emoji reactions by mode (gentle & occasional)
const MODE_REACTIONS = {
  chill: ['🫶', '🧊', '🌿'],
  villain: ['🦹‍♂️', '🩸', '🕯️'],
  motivator: ['💪', '🔥', '🚀'],
  default: ['🟪', '🤖', '⚡'],
};

function maybeReact(message, mode = 'default') {
  const pool = MODE_REACTIONS[mode] || MODE_REACTIONS.default;
  if (Math.random() < 0.25) { // 25% chance to add a tiny vibe reaction
    const emoji = pool[Math.floor(Math.random() * pool.length)];
    message.react(emoji).catch(() => {});
  }
}

/** Helper: safe channel to speak in */
function findSpeakableChannel(guild, preferredChannelId = null) {
  const me = guild.members.me;
  if (!me) return null;
  const canSend = (ch) =>
    ch &&
    ch.isTextBased?.() &&
    ch.permissionsFor(me)?.has(PermissionsBitField.Flags.SendMessages);

  if (preferredChannelId) {
    const ch = guild.channels.cache.get(preferredChannelId);
    if (canSend(ch)) return ch;
  }
  // system channel?
  if (guild.systemChannel && canSend(guild.systemChannel)) return guild.systemChannel;

  // first sendable text channel
  return guild.channels.cache.find((c) => canSend(c)) || null;
}

/** Lightweight recent context from channel (non-bot, short, last ~6 msgs) */
async function getRecentContext(message) {
  try {
    const fetched = await message.channel.messages.fetch({ limit: 8 });
    const lines = [];
    for (const [, m] of fetched) {
      if (m.id === message.id) continue; // avoid echoing the current message
      if (m.author?.bot) continue;
      const txt = (m.content || '').trim();
      if (!txt) continue;
      // Keep short snippets only
      const oneLine = txt.replace(/\s+/g, ' ').slice(0, 200);
      lines.push(`${m.author.username}: ${oneLine}`);
      if (lines.length >= 6) break;
    }
    if (!lines.length) return '';
    // Most recent first
    return `Recent context:\n` + lines.join('\n');
  } catch {
    return '';
  }
}

/** Random pick helper */
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** ====== Quick Actions (lightweight, non-breaking) ======
 * Detects simple patterns and returns a short string “action result”
 * that we’ll prepend to the prompt (so Groq can riff on it).
 * We also optionally show a tiny inline embed before the main reply.
 */
function quickActionDetect(raw) {
  const text = raw.toLowerCase();

  // coin flip
  if (/\b(coin|flip)\b/.test(text)) {
    return { title: 'Coin Flip', result: Math.random() < 0.5 ? 'Heads' : 'Tails' };
  }

  // dice roll: d6 or d20
  if (/\b(roll|dice)\b/.test(text)) {
    const d = /d20\b/.test(text) ? 20 : 6;
    const v = 1 + Math.floor(Math.random() * d);
    return { title: `Dice Roll d${d}`, result: `${v}` };
  }

  // 8-ball
  if (/\b(8ball|8-ball|eight ball)\b/.test(text)) {
    const outs = [
      'Yes.', 'No.', 'It is certain.', 'Very doubtful.', 'Ask again later.',
      'Signs point to yes.', 'Outlook not so good.', 'Without a doubt.',
      'Better not tell you now.', 'Concentrate and ask again.'
    ];
    return { title: '🎱 Magic 8-Ball', result: pick(outs) };
  }

  // pick between A or B
  const orMatch = raw.match(/\b(.{1,40})\s+or\s+(.{1,40})\b/i);
  if (orMatch && orMatch[1] && orMatch[2]) {
    const a = orMatch[1].trim();
    const b = orMatch[2].trim();
    const choice = Math.random() < 0.5 ? a : b;
    return { title: 'Random Pick', result: `I choose: **${choice}**` };
  }

  // hype line on demand
  if (/\b(hype me|motivate me|pump me up)\b/.test(text)) {
    const lines = [
      'Add 10lbs to your day and lift it. You got this. 💪',
      'You don’t need permission — you need reps. 🚀',
      'Small steps, savage consistency. 🔥',
      'Your ceiling is just your last excuse. Break it. 🧨',
    ];
    return { title: 'Hype', result: pick(lines) };
  }

  return null;
}

/** Build a tiny action embed */
function buildActionEmbed(action) {
  if (!action) return null;
  return new EmbedBuilder()
    .setColor('#2ecc71')
    .setTitle(action.title)
    .setDescription(action.result)
    .setFooter({ text: 'MuscleMB quick action ✅' });
}

module.exports = (client) => {
  /** Periodic nice pings (lightweight) */
  setInterval(async () => {
    const now = Date.now();
    // iterate guilds we’ve seen activity for
    const byGuild = new Map(); // guildId -> [{userId, channelId, ts}]
    for (const [key, info] of lastActiveByUser.entries()) {
      const [guildId, userId] = key.split(':');
      if (!byGuild.has(guildId)) byGuild.set(guildId, []);
      byGuild.get(guildId).push({ userId, channelId: info.channelId, ts: info.ts });
    }

    for (const [guildId, entries] of byGuild.entries()) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const lastPingTs = lastNicePingByGuild.get(guildId) || 0;
      if (now - lastPingTs < NICE_PING_EVERY_MS) continue; // not time yet

      // active within window
      const active = entries.filter(e => now - e.ts <= NICE_ACTIVE_WINDOW_MS);
      if (!active.length) continue;

      // choose 1–2 random active members to nudge (not spammy)
      const targets = [pick(active)];
      if (active.length > 3 && Math.random() < 0.5) {
        // maybe a second one, different channel if possible
        let candidate = pick(active);
        let attempts = 0;
        while (attempts++ < 5 && targets.find(t => t.userId === candidate.userId)) {
          candidate = pick(active);
        }
        if (!targets.find(t => t.userId === candidate.userId)) targets.push(candidate);
      }

      // Send one group message per guild, to a good channel
      const preferredChannel = targets[0]?.channelId || null;
      const channel = findSpeakableChannel(guild, preferredChannel);
      if (!channel) continue;

      const nice = pick(NICE_LINES);
      try {
        await channel.send(`✨ quick vibe check: ${nice}`);
        lastNicePingByGuild.set(guildId, now);
      } catch {/* ignore */}
    }
  }, NICE_SCAN_EVERY_MS);

  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // Track activity for later nice pings
    lastActiveByUser.set(`${message.guild.id}:${message.author.id}`, {
      ts: Date.now(),
      channelId: message.channel.id,
    });

    const lowered = message.content.toLowerCase();
    const botMentioned = message.mentions.has(client.user);
    const hasTriggerWord = TRIGGERS.some(trigger => lowered.includes(trigger));

    if (!hasTriggerWord && !botMentioned) return;
    if (message.mentions.everyone || message.mentions.roles.size > 0) return;

    const mentionedUsers = message.mentions.users.filter(u => u.id !== client.user.id);
    const shouldRoast = (hasTriggerWord || botMentioned) && mentionedUsers.size > 0;
    const isRoastingBot = shouldRoast && message.mentions.has(client.user) && mentionedUsers.size === 1 && mentionedUsers.has(client.user.id);

    const isOwner = message.author.id === process.env.BOT_OWNER_ID;
    if (cooldown.has(message.author.id) && !isOwner) return;
    cooldown.add(message.author.id);
    setTimeout(() => cooldown.delete(message.author.id), 10000);

    let cleanedInput = lowered;
    TRIGGERS.forEach(trigger => {
      cleanedInput = cleanedInput.replaceAll(trigger, '');
    });
    message.mentions.users.forEach(user => {
      cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, '');
      cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, '');
    });
    cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, '').trim();

    let introLine = '';
    if (hasTriggerWord) {
      introLine = `Detected trigger word: "${TRIGGERS.find(trigger => lowered.includes(trigger))}". `;
    } else if (botMentioned) {
      introLine = `You mentioned MuscleMB directly. `;
    }
    if (!cleanedInput) cleanedInput = shouldRoast ? 'Roast these fools.' : 'Speak your alpha.';
    cleanedInput = `${introLine}${cleanedInput}`;

    // Detect quick actions (non-breaking). If present, we’ll:
    // 1) send a small action embed first,
    // 2) also feed action result back into the LLM for contextual riffing.
    const action = quickActionDetect(message.content || '');
    const actionEmbed = buildActionEmbed(action);

    try {
      await message.channel.sendTyping();

      const isRoast = shouldRoast && !isRoastingBot;
      const roastTargets = [...mentionedUsers.values()].map(u => u.username).join(', ');

      // ------ Mode from DB (no random override if DB has one) ------
      let currentMode = 'default';
      try {
        const modeRes = await client.pg.query(
          `SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`,
          [message.guild.id]
        );
        currentMode = modeRes.rows[0]?.mode || 'default';
      } catch (err) {
        console.warn('⚠️ Failed to fetch mb_mode, using default.');
      }

      // Tiny mode-based reaction for flavor (non-blocking)
      maybeReact(message, currentMode);

      // Lightweight recent context (gives MB more awareness)
      const recentContext = await getRecentContext(message);

      // Persona overlays kept minimal; nicer tone by default in non-roast modes
      let systemPrompt = '';
      if (isRoast) {
        systemPrompt =
          `You are MuscleMB — a savage roastmaster. Ruthlessly roast these tagged degens: ${roastTargets}. ` +
          `Keep it short, witty, and funny. Avoid slurs or harassment; punch up with humor. Use spicy emojis. 💀🔥`;
      } else if (isRoastingBot) {
        systemPrompt =
          `You are MuscleMB — unstoppable gym-bro AI. Someone tried to roast you; clap back with confident swagger, ` +
          `but keep it playful and not mean-spirited. 💪🤖✨`;
      } else {
        switch (currentMode) {
          case 'chill':
            systemPrompt = 'You are MuscleMB — chill, friendly, and helpful. Be positive and conversational. Keep replies concise. 🧘‍♂️';
            break;
          case 'villain':
            systemPrompt = 'You are MuscleMB — a theatrical villain. Ominous but playful; keep it concise and entertaining. 🦹‍♂️';
            break;
          case 'motivator':
            systemPrompt = 'You are MuscleMB — alpha motivational coach. Short hype lines, workout metaphors, lots of energy. 💪🔥';
            break;
          default:
            systemPrompt = 'You are 💪 MuscleMB — an alpha degen AI who flips JPEGs and lifts. Keep replies short, smart, and spicy (but not rude).';
        }
      }

      // Add context & guardrails + brevity instruction
      const softGuard =
        'Be kind by default, avoid insults unless explicitly roasting. No private data. Keep it 1–3 short sentences max.';
      const fullSystemPrompt = [systemPrompt, softGuard, recentContext].filter(Boolean).join('\n\n');

      let temperature = 0.7;
      if (currentMode === 'villain') temperature = 0.5;
      if (currentMode === 'motivator') temperature = 0.9;

      // If an action was detected, fold its result into the user content so MB riffs with it
      const userMsg = action
        ? `${cleanedInput}\n\n(Quick action performed: ${action.title} => ${action.result})`
        : cleanedInput;

      // Optional: post the quick action embed before the main reply (non-blocking if it fails)
      if (actionEmbed) {
        message.reply({ embeds: [actionEmbed] }).catch(() => {});
      }

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama3-70b-8192',
          temperature,
          max_tokens: 160, // a bit more space for better jokes/answers, still concise
          messages: [
            { role: 'system', content: fullSystemPrompt },
            { role: 'user', content: userMsg },
          ],
        }),
      });

      const data = await response.json();
      const aiReply = data.choices?.[0]?.message?.content?.trim();

      if (aiReply?.length) {
        let embedColor = '#9b59b6';
        const modeColorMap = {
          chill: '#3498db',
          villain: '#8b0000',
          motivator: '#e67e22',
          default: '#9b59b6'
        };
        embedColor = modeColorMap[currentMode] || embedColor;

        const emojiMap = {
          '#3498db': '🟦',
          '#8b0000': '🟥',
          '#e67e22': '🟧',
          '#9b59b6': '🟪',
        };
        const footerEmoji = emojiMap[embedColor] || '🟪';

        const embed = new EmbedBuilder()
          .setColor(embedColor)
          .setDescription(`💬 ${aiReply}`)
          .setFooter({ text: `Mode: ${currentMode} ${footerEmoji}` });

        const delayMs = Math.min(aiReply.length * 40, 5000);
        await new Promise(resolve => setTimeout(resolve, delayMs));

        try {
          await message.reply({ embeds: [embed] });
        } catch (err) {
          console.warn('❌ MuscleMB embed reply error:', err.message);
        }
      }

    } catch (err) {
      console.error('❌ MuscleMB error:', err?.stack || err?.message || String(err));
      try {
        await message.reply('⚠️ MuscleMB pulled a hammy 🦵. Try again soon.');
      } catch (fallbackErr) {
        console.warn('❌ Fallback send error:', fallbackErr.message);
      }
    }
  });
};

