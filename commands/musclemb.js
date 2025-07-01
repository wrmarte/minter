const { SlashCommandBuilder } = require('discord.js');
const fetch = require('node-fetch');

const GROQ_API_KEY = process.env.GROQ_API_KEY; // 🔑 Set this in Railway

module.exports = {
  data: new SlashCommandBuilder()
    .setName('musclemb')
    .setDescription('Talk to MuscleMB — your savage degen AI')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('What do you want to ask this beast?')
        .setRequired(true)
    ),

  async execute(interaction) {
    const userMsg = interaction.options.getString('message');
    await interaction.deferReply();

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama3-70b-8192', // ✅ Savage LLaMA 3
          messages: [
            {
              role: 'system',
              content: 'You are MuscleMB — an uncensored, degen AI who lifts, flips JPEGs, and spits savage alpha. Stay raw, real, and ruthless.',
            },
            {
              role: 'user',
              content: userMsg,
            }
          ],
          temperature: 0.95,
        }),
      });

      const data = await response.json();
      const aiReply = data.choices?.[0]?.message?.content || '💤 Still recovering from chest day.';
      await interaction.editReply(aiReply);

    } catch (err) {
      console.error('❌ MuscleMB (Groq) error:', err.message);
      await interaction.editReply('⚠️ MuscleMB is benched for now. Try again later.');
    }
  },
};

