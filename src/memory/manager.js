const fs = require('fs');
const path = require('path');

const MEMORY_BASE = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.multis', 'memory', 'chats'
);

/**
 * Per-chat memory manager — handles profile, recent messages, durable memory, and daily logs.
 * All I/O is synchronous (single process, no concurrency).
 */
class ChatMemoryManager {
  constructor(chatId) {
    this.chatId = String(chatId);
    this.dir = path.join(MEMORY_BASE, this.chatId);
    this.profilePath = path.join(this.dir, 'profile.json');
    this.recentPath = path.join(this.dir, 'recent.json');
    this.memoryPath = path.join(this.dir, 'memory.md');
    this.logDir = path.join(this.dir, 'log');
    this.ensureDirectories();
  }

  ensureDirectories() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
  }

  // --- Profile ---

  loadProfile() {
    if (!fs.existsSync(this.profilePath)) {
      return { mode: 'personal', platform: null, lastActive: null, created: new Date().toISOString() };
    }
    return JSON.parse(fs.readFileSync(this.profilePath, 'utf-8'));
  }

  saveProfile(profile) {
    profile.lastActive = new Date().toISOString();
    fs.writeFileSync(this.profilePath, JSON.stringify(profile, null, 2));
  }

  // --- Recent messages (rolling window) ---

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

  // --- Durable memory (memory.md) ---

  loadMemory() {
    if (!fs.existsSync(this.memoryPath)) return '';
    return fs.readFileSync(this.memoryPath, 'utf-8');
  }

  appendMemory(notes) {
    const header = `\n## ${new Date().toISOString()}\n\n`;
    fs.appendFileSync(this.memoryPath, header + notes.trim() + '\n');
  }

  clearMemory() {
    fs.writeFileSync(this.memoryPath, '');
  }

  // --- Daily log (append-only) ---

  appendToLog(role, content) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19);
    const logFile = path.join(this.logDir, `${dateStr}.md`);
    const entry = `### ${timeStr} [${role}]\n${content}\n\n`;
    fs.appendFileSync(logFile, entry);
  }

  // --- Capture threshold ---

  shouldCapture(threshold = 20) {
    const messages = this.loadRecent();
    return messages.length >= threshold;
  }
}

/**
 * Get or create a ChatMemoryManager for a chatId.
 * Uses a Map cache to avoid re-creating managers.
 */
function getMemoryManager(cache, chatId) {
  if (!cache.has(chatId)) {
    cache.set(chatId, new ChatMemoryManager(chatId));
  }
  return cache.get(chatId);
}

module.exports = { ChatMemoryManager, getMemoryManager };
