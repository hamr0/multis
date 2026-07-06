'use strict';

/**
 * M8 module 1 — the personal-mode name trigger (PRD §524).
 *
 * In `personal` mode the bot responds ONLY when the assistant's name is called. The match is
 * case-insensitive, word-boundary, and fires on ANY whitespace-split token of the name — so
 * `"Roger bot"` fires on `roger` OR `bot`, while the word-boundary means `robot`/`chatbot` do NOT.
 *
 * Pure and dependency-free so it can be TDD'd in isolation and imported by `beeper.js` routing.
 *
 * @param {string} text  the incoming message body
 * @param {string} name  config.assistant_name (one or more whitespace-separated tokens)
 * @returns {boolean}    true iff some name token appears in `text` as a whole word
 */
function nameIsCalled(text, name) {
  if (typeof text !== 'string' || typeof name !== 'string') return false;
  const tokens = name.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  // Word-boundary, case-insensitive, per token. Metachars are escaped so a token matches literally
  // (a `.` in a name is a dot, not "any char") and a name like `c++` can't throw an invalid-regex.
  return tokens.some((tok) => new RegExp(`\\b${escapeRegex(tok)}\\b`, 'i').test(text));
}

/** Escape the RegExp metacharacters so a token is matched as a literal string. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { nameIsCalled };
