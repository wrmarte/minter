// listeners/mbella/text.js
// ======================================================
// Output safety + formatting helpers
// ======================================================

function sanitizeOutput(text) {
  let t = String(text || "").trim();
  if (!t) return "";
  t = t.replace(/@everyone/g, "@\u200Beveryone").replace(/@here/g, "@\u200Bhere");
  if (t.length > 1800) t = t.slice(0, 1797).trimEnd() + "…";
  return t;
}

function deRobotify(text) {
  let t = String(text || "");
  t = t.replace(/\b(as an ai|as a language model|i am an ai|i’m an ai|i cannot|i can't)\b/gi, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

function enforceQuestionLimit(text, maxQuestions = 0) {
  let t = String(text || "");
  if (maxQuestions >= 2) return t;

  const qCount = (t.match(/\?/g) || []).length;
  if (qCount <= maxQuestions) return t;

  let seen = 0;
  t = t.replace(/\?/g, () => {
    seen += 1;
    return seen <= maxQuestions ? "?" : ".";
  });

  if (maxQuestions === 0) {
    t = t.replace(/\b(right|ok|okay|yeah|ya)\.\s*$/i, ".");
  }
  return t;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  sanitizeOutput,
  deRobotify,
  enforceQuestionLimit,
  escapeRegex,
};
