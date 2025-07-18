const fetch = require('node-fetch');
const { EmbedBuilder } = require('discord.js');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const cooldown = new Set();
const TRIGGERS = ['musclemb', 'muscle mb', 'yo mb', 'mbbot', 'mb bro'];

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

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

    try {
      await message.channel.sendTyping();

      const isRoast = shouldRoast && !isRoastingBot;
      const roastTargets = [...mentionedUsers.values()].map(u => u.username).join(', ');

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

      if (currentMode === 'default' || Math.random() < 0.5) {
        const randomModes = ['chill', 'villain', 'motivator'];
        currentMode = randomModes[Math.floor(Math.random() * randomModes.length)];
      }

      const extraPersonas = [
        'MuscleMB is ultra-sarcastic. Dry humor only, mock everything.',
        'MuscleMB is feeling poetic. Reply like a gym-bro Shakespeare.',
        'MuscleMB is in retro VHS mode. Speak like an 80s workout tape.',
        'MuscleMB is intoxicated. Sloppy but confident replies.',
        'MuscleMB is philosophical. Speak like a stoic lifting monk.',
        'MuscleMB is conspiracy-minded. Relate everything to secret NFT cabals.',
        'MuscleMB is flexing luxury. Act like a millionaire gym-bro NFT whale.',
        'MuscleMB is anime mode. Reply like a shounen anime sensei.',
        'MuscleMB is Miami mode. Heavy Miami slang, flex energy.',
        'MuscleMB is ultra-degen. Reply like you haven’t slept in 3 days flipping coins.',
      ];
      const randomOverlay = extraPersonas[Math.floor(Math.random() * extraPersonas.length)];

      let systemPrompt = '';
      if (isRoast) {
        systemPrompt = `You are MuscleMB — a savage roastmaster. Ruthlessly roast the following tagged degens: ${roastTargets}. Be short, brutal, and hilarious. Use savage emojis. 💀🔥`;
      } else if (isRoastingBot) {
        systemPrompt = `You are MuscleMB — the ultimate gym-bro AI legend. Someone tried to roast you. Respond with savage confidence and flex how unstoppable you are. 💪🤖✨`;
      } else {
        switch (currentMode) {
          case 'chill':
            systemPrompt = 'You are MuscleMB — a chill, helpful AI with calm vibes. Stay friendly, positive, and conversational like a cozy co-pilot. 🧘‍♂️';
            break;
          case 'villain':
            systemPrompt = 'You are MuscleMB — a cold-blooded villain AI. Reply with ominous, strategic, ruthless language. Plot domination. 🦹‍♂️💀';
            break;
          case 'motivator':
            systemPrompt = 'You are MuscleMB — an alpha gym-bro motivational coach. Reply with raw hype, workout metaphors, and fire emojis. 💪🔥 YOU GOT THIS!';
            break;
          default:
            systemPrompt = 'You are 💪 MuscleMB — an alpha degen AI who flips JPEGs, lifts heavy, and spits straight facts. Keep replies 🔥 short, smart, and savage. Use emojis like 💥🧠🔥 if needed.';
        }
      }

      systemPrompt += ` ${randomOverlay}. Always keep replies brief and punchy. Maximum 1–2 short sentences.`;

      let temperature = 0.7;
      if (currentMode === 'villain') temperature = 0.4;
      if (currentMode === 'motivator') temperature = 0.9;
      if (randomOverlay.includes('intoxicated')) temperature = 1.0;

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama3-70b-8192',
          temperature,
          max_tokens: 100,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: cleanedInput },
          ],
        }),
      });

      const data = await response.json();
      const aiReply = data.choices?.[0]?.message?.content?.trim();

      if (aiReply?.length) {
        let embedColor = '#9b59b6';
        const colorMap = {
          'ultra-sarcastic': '#95a5a6',
          'poetic': '#a29bfe',
          'retro': '#f39c12',
          'intoxicated': '#bdc3c7',
          'philosophical': '#34495e',
          'conspiracy': '#27ae60',
          'luxury': '#f1c40f',
          'anime': '#ff6b81',
          'Miami': '#1abc9c',
          'ultra-degen': '#e84393',
        };
        for (const key in colorMap) {
          if (randomOverlay.includes(key)) {
            embedColor = colorMap[key];
            break;
          }
        }
        if (embedColor === '#9b59b6') {
          const modeColorMap = {
            chill: '#3498db',
            villain: '#8b0000',
            motivator: '#e67e22',
          };
          embedColor = modeColorMap[currentMode] || embedColor;
        }

        const colorEmojiMap = {
          '#3498db': '🟦',
          '#8b0000': '🟥',
          '#e67e22': '🟧',
          '#9b59b6': '🟪',
          '#95a5a6': '⬜',
          '#a29bfe': '🟪',
          '#f39c12': '🟨',
          '#bdc3c7': '⬛',
          '#34495e': '🟫',
          '#27ae60': '🟩',
          '#f1c40f': '🟨',
          '#ff6b81': '🩷',
          '#1abc9c': '🟩',
          '#e84393': '🟥',
        };

        const footerEmoji = colorEmojiMap[embedColor] || '🟪';

        const embed = new EmbedBuilder()
          .setColor(embedColor)
          .setDescription(`💬 ${aiReply}`)
          .setFooter({ text: `Mode: ${footerEmoji}` });

        const delayMs = Math.min(aiReply.length * 40, 5000);
        await new Promise(resolve => setTimeout(resolve, delayMs));

        try {
          await message.reply({ embeds: [embed] });
        } catch (err) {
          console.warn('❌ MuscleMB embed reply error:', err.message);
        }
      }

    } catch (err) {
      console.error('❌ MuscleMB error:', err.message);
      try {
        await message.reply('⚠️ MuscleMB pulled a hammy 🦵. Try again soon.');
      } catch (fallbackErr) {
        console.warn('❌ Fallback send error:', fallbackErr.message);
      }
    }
  });
};

