const fs = require('fs');
const path = require('path');

const MEMORY_BASE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.multis', 'memory', 'chats'
);

/**
 * Per-chat conversation window + raw daily log.
 *
 * Since M4, durable memory (facts/episodes, recall, promotion, retention) lives in litectx
 * (see src/context). This manager keeps ONLY the two things litectx does not:
 *   - recent.json — the short-term conversation thread the agent loop replays across messages
 *     (litectx has no time-ordered episode-recency verb yet; that is the open
 *     `recent-memory-by-scope` ask / M5 `assemble`). Cap'd, no LLM.
 *   - daily logs — a verbatim, never-indexed forensic transcript.
 * All I/O is synchronous (single process, no concurrency).
 */
class ChatMemoryManager {
  constructor(chatId, options = {}) {
    this.chatId = String(chatId);
    const base = options.baseDir || MEMORY_BASE;
    this.dir = path.join(base, this.chatId);
    this.recentPath = path.join(this.dir, 'recent.json');
    this.logDir = path.join(this.dir, 'log');
    this.ensureDirectories();
  }

  ensureDirectories() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
  }

  // --- Recent messages (rolling conversation window) ---

  loadRecent() {
    if (!fs.existsSync(this.recentPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.recentPath, 'utf-8'));
    } catch {
      return [];
    }
  }

  saveRecent(messages) {
    fs.writeFileSync(this.recentPath, JSON.stringify(messages, null, 2));
  }

  appendMessage(role, content, timestamp = null) {
    const messages = this.loadRecent();
    messages.push({
      role,
      content,
      timestamp: timestamp || new Date().toISOString()
    });
    this.saveRecent(messages);
    return messages;
  }

  trimRecent(keepLast = 5) {
    const messages = this.loadRecent();
    if (messages.length <= keepLast) return messages;
    const trimmed = messages.slice(-keepLast);
    this.saveRecent(trimmed);
    return trimmed;
  }

  // --- Daily log (append-only, never indexed) ---

  appendToLog(role, content) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19);
    const logFile = path.join(this.logDir, `${dateStr}.md`);
    const entry = `### ${timeStr} [${role}]\n${content}\n\n`;
    fs.appendFileSync(logFile, entry);
  }
}

/**
 * Get or create a ChatMemoryManager for a chatId.
 * Uses a Map cache to avoid re-creating managers.
 */
function getMemoryManager(cache, chatId, options = {}) {
  const key = `${chatId}:${options.isAdmin ? 'admin' : 'user'}`;
  if (!cache.has(key)) {
    cache.set(key, new ChatMemoryManager(chatId, options));
  }
  return cache.get(key);
}

module.exports = { ChatMemoryManager, getMemoryManager };
