const fs = require('fs');
const path = require('path');

const MEMORY_BASE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.multis', 'memory', 'chats'
);

/**
 * Per-chat raw daily log.
 *
 * Since M4, durable memory AND the conversation thread both live in litectx (see src/context):
 * every exchange is an `episode`, and the agent's message window is reconstructed from litectx
 * episode-recency (`recentMemory`, 0.23.0) — so the old `recent.json` window is gone. This manager
 * keeps ONLY the one thing litectx does not: the verbatim, never-indexed daily log (forensic backup).
 * All I/O is synchronous (single process, no concurrency).
 */
class ChatMemoryManager {
  constructor(chatId, options = {}) {
    this.chatId = String(chatId);
    const base = options.baseDir || MEMORY_BASE;
    this.dir = path.join(base, this.chatId);
    this.logDir = path.join(this.dir, 'log');
    this.ensureDirectories();
  }

  ensureDirectories() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
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
