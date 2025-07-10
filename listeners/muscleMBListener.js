const fetch = require('node-fetch');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const cooldown = new Set();
const TRIGGERS = ['musclemb', 'muscle mb', 'yo mb', 'mbbot', 'mb bro'];

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const lowered = message.content.toLowerCase();
    const botMentioned = message.mentions.has(client.user);
    const hasTriggerWord = TRIGGERS.some(trigger => lowered.includes(trigger));

    const mentionedUsers = message.mentions.users.filter(u => u.id !== client.user.id);
    const shouldRoast = (hasTriggerWord || botMentioned) && mentionedUsers.size > 0;
    const isRoastingBot = shouldRoast && message.mentions.has(client.user) && mentionedUsers.size === 1 && mentionedUsers.has(client.user.id);

    if (!hasTriggerWord && !botMentioned) return;

    if (cooldown.has(message.author.id)) return;
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
    if (!cleanedInput) cleanedInput = shouldRoast ? 'Roast these fools.' : 'Speak your alpha.';

    try {
      await message.channel.sendTyping();

      const isRoast = shouldRoast && !isRoastingBot;
      const roastTargets = [...mentionedUsers.values()].map(u => u.username).join(', ');

      let currentMode = 'default';
      try {
        const modeRes = await client.pg.query(
          `SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`,
          [message.guild?.id]
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

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama3-70b-8192',
          temperature: 0.7,
          max_tokens: 180,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: cleanedInput },
          ],
        }),
      });

      const data = await response.json();
      const aiReply = data.choices?.[0]?.message?.content?.trim();

      if (aiReply && aiReply.length > 0) {
        try {
          await message.reply(`💬 ${aiReply} 💪`);
        } catch (err) {
          if (err.code === 50013) {
            console.warn('⚠️ MuscleMB can’t reply — missing permissions in channel.');
          } else {
            console.warn('❌ MuscleMB reply error:', err.message);
          }
        }
      }

    } catch (err) {
      console.error('❌ MuscleMB error:', err.message);
      try {
        await message.reply('⚠️ MuscleMB pulled a hammy 🦵. Try again soon.');
      } catch (fallbackErr) {
        if (fallbackErr.code === 50013) {
          console.warn('⚠️ Fallback message failed — missing permissions.');
        } else {
          console.warn('❌ Fallback send error:', fallbackErr.message);
        }
      }
    }
  });
};
