// listeners/mbella/vibe.js
// ======================================================
// Vibe + intensity detection
// ======================================================

function computeIntensityScore(text) {
  const t = String(text || "");
  let score = 0;
  if (/[A-Z]{5,}/.test(t)) score += 1;
  if ((t.match(/!/g) || []).length >= 3) score += 1;
  if ((t.match(/\?/g) || []).length >= 3) score += 1;
  if (/\b(fuck|shit|damn|hell|wtf|lmao|lmfao)\b/i.test(t)) score += 1;
  if (/\b(angry|mad|pissed|annoyed|rage|crash|broken|fix now|urgent|fix it)\b/i.test(t)) score += 1;
  if (/\b(love|miss|baby|babe|hot|sexy|flirt|kiss|date|romantic)\b/i.test(t)) score += 1;
  return Math.min(6, score);
}

function detectVibe(text) {
  const t = String(text || "").toLowerCase();

  const romantic = /\b(love|miss|babe|baby|kiss|date|cuddle|romantic|sweet|sexy|hot)\b/.test(t);
  const salty = /\b(stfu|shut up|annoying|hate|bitchy|sass|roast|clap back)\b/.test(t);
  const sad = /\b(sad|lonely|depressed|down|hurt|cry|heartbroken|anxious)\b/.test(t);
  const hype = /\b(lfg|moon|pump|send it|wagmi|ape)\b|🚀|🔥/.test(t);
  const tech = /\b(error|bug|fix|issue|stack|trace|deploy|build|node|discord|ethers|sql)\b/.test(t);

  if (sad) return "comfort";
  if (romantic) return "romantic";
  if (salty) return "sass";
  if (tech) return "helpful";
  if (hype) return "hype";
  return "default";
}

module.exports = {
  computeIntensityScore,
  detectVibe,
};
