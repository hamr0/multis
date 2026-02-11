const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MULTIS_DIR } = require('../config');

const SESSIONS_PATH = path.join(MULTIS_DIR, 'pin_sessions.json');

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function verifyPin(pin, hash) {
  return hashPin(pin) === hash;
}

/**
 * PinManager — handles PIN auth for owner commands.
 * Sessions persist to ~/.multis/pin_sessions.json.
 */
class PinManager {
  constructor(config) {
    this.config = config;
    this.sessions = this._loadSessions();
    this.pendingCommands = new Map(); // userId -> { command, args, msg, platform, timestamp }
    this.failCounts = new Map(); // userId -> { count, lockedUntil }
  }

  isEnabled() {
    return !!this.config.security?.pin_hash;
  }

  needsAuth(userId) {
    if (!this.isEnabled()) return false;

    // Check lockout
    const fail = this.failCounts.get(userId);
    if (fail && fail.lockedUntil && Date.now() < fail.lockedUntil) {
      return 'locked';
    }

    const session = this.sessions[userId];
    if (!session) return true;

    const timeoutMs = (this.config.security.pin_timeout_hours || 24) * 3600 * 1000;
    if (Date.now() - session.authenticated_at > timeoutMs) return true;

    return false;
  }

  authenticate(userId, pin) {
    const hash = this.config.security.pin_hash;
    if (!hash) return { success: false, reason: 'No PIN configured' };

    // Check lockout
    const fail = this.failCounts.get(userId);
    if (fail && fail.lockedUntil && Date.now() < fail.lockedUntil) {
      const remaining = Math.ceil((fail.lockedUntil - Date.now()) / 60000);
      return { success: false, reason: `Locked out. Try again in ${remaining} minutes.` };
    }

    if (verifyPin(pin, hash)) {
      // Success — create session, clear failures
      this.sessions[userId] = { authenticated_at: Date.now() };
      this._saveSessions();
      this.failCounts.delete(userId);
      return { success: true };
    }

    // Failed attempt
    const current = this.failCounts.get(userId) || { count: 0 };
    current.count++;
    if (current.count >= 3) {
      const lockoutMs = (this.config.security.pin_lockout_minutes || 60) * 60 * 1000;
      current.lockedUntil = Date.now() + lockoutMs;
      this.failCounts.set(userId, current);
      return { success: false, reason: `Wrong PIN. Locked out for ${this.config.security.pin_lockout_minutes || 60} minutes.`, locked: true };
    }

    this.failCounts.set(userId, current);
    return { success: false, reason: `Wrong PIN. ${3 - current.count} attempts remaining.` };
  }

  hasPending(userId) {
    return this.pendingCommands.has(userId);
  }

  setPending(userId, pending) {
    this.pendingCommands.set(userId, { ...pending, timestamp: Date.now() });
  }

  getPending(userId) {
    const p = this.pendingCommands.get(userId);
    // Expire after 5 minutes
    if (p && Date.now() - p.timestamp > 300000) {
      this.pendingCommands.delete(userId);
      return null;
    }
    return p;
  }

  clearPending(userId) {
    this.pendingCommands.delete(userId);
  }

  _loadSessions() {
    try {
      if (fs.existsSync(SESSIONS_PATH)) {
        return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf-8'));
      }
    } catch { /* ignore corrupt file */ }
    return {};
  }

  _saveSessions() {
    const dir = path.dirname(SESSIONS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(this.sessions, null, 2));
  }
}

module.exports = { PinManager, hashPin, verifyPin };
