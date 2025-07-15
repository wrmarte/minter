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

    // ✅ Clean filter: only trigger on real triggers, ignore mass mentions
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
      const randomOverlay = Math.random() < 0.4 ? extraPersonas[Math.floor(Math.random() * extraPersonas.length)] : null;
      if (randomOverlay) systemPrompt += ` ${randomOverlay}`;

      let temperature = 0.7;
      if (currentMode === 'villain') temperature = 0.4;
      if (currentMode === 'motivator') temperature = 0.9;
      if (randomOverlay?.includes('intoxicated')) temperature = 1.0;

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama3-70b-8192',
          temperature,
          max_tokens: 180,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: cleanedInput },
          ],
        }),
      });

      const data = await response.json();
      const aiReply = data.choices?.[0]?.message?.content?.trim();

      if (aiReply?.length) {
        const embed = new EmbedBuilder()
          .setColor('#ff007f')
          .setDescription(`💬 ${aiReply}`)
          .setFooter({ text: `Mode: ${currentMode}${randomOverlay ? ` • ${randomOverlay}` : ''}` });

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

