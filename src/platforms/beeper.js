const fs = require('fs');
const path = require('path');
const { Platform } = require('./base');
const { Message } = require('./message');
const { logAudit } = require('../governance/audit');

const DEFAULT_URL = 'http://localhost:23373';
const DEFAULT_POLL_INTERVAL = 3000;
const TOKEN_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.multis', 'beeper-token.json');

/**
 * Beeper Desktop API platform adapter.
 * Polls localhost:23373 for new messages, processes // commands from self.
 */
class BeeperPlatform extends Platform {
  constructor(config) {
    super('beeper', config);
    const bc = config.platforms?.beeper || {};
    this.baseUrl = bc.url || DEFAULT_URL;
    this.pollInterval = bc.poll_interval || DEFAULT_POLL_INTERVAL;
    this.commandPrefix = bc.command_prefix || '//';
    this.token = null;
    this.selfIds = new Set(); // account user IDs to detect self-messages
    this._pollTimer = null;
    this._lastSeen = {}; // chatId -> last message ID (numeric) we processed
    this._initialized = false; // first poll seeds _lastSeen without processing
  }

  async start() {
    this.token = this._loadToken();
    if (!this.token) {
      console.error('Beeper: no token found. Run: node src/cli/setup-beeper.js');
      return;
    }

    // Verify token and discover self IDs
    try {
      const accounts = await this._api('GET', '/v1/accounts');
      const list = Array.isArray(accounts) ? accounts : accounts.items || [];
      for (const acc of list) {
        if (acc.user?.id) this.selfIds.add(acc.user.id);
        if (acc.accountID) this.selfIds.add(acc.accountID);
      }
      console.log(`Beeper: connected (${list.length} accounts)`);
    } catch (err) {
      console.error(`Beeper: token invalid or Desktop not running — ${err.message}`);
      return;
    }

    // Seed _lastSeen with current message IDs so we don't process old messages
    await this._seedLastSeen();
    this._initialized = true;

    // Start polling
    this._pollTimer = setInterval(() => this._poll(), this.pollInterval);
    console.log(`Beeper: polling every ${this.pollInterval}ms for ${this.commandPrefix} commands`);
  }

  async stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async send(chatId, text) {
    // Prefix responses so they're distinguishable from user's own messages
    const prefixed = `[multis] ${text}`;
    await this._api('POST', `/v1/chats/${encodeURIComponent(chatId)}/messages`, { text: prefixed });
  }

  async _seedLastSeen() {
    try {
      const data = await this._api('GET', '/v1/chats?limit=20');
      const chats = data.items || [];
      for (const chat of chats) {
        const chatId = chat.id || chat.chatID;
        if (!chatId) continue;
        const msgData = await this._api('GET', `/v1/chats/${encodeURIComponent(chatId)}/messages?limit=1`);
        const messages = msgData.items || [];
        if (messages.length > 0) {
          const id = messages[0].id || messages[0].messageID;
          if (id) this._lastSeen[chatId] = Number(id);
        }
      }
    } catch (err) {
      console.error(`Beeper: seed error — ${err.message}`);
    }
  }

  async _poll() {
    if (!this._initialized) return;
    try {
      const data = await this._api('GET', '/v1/chats?limit=20');
      const chats = data.items || [];

      for (const chat of chats) {
        const chatId = chat.id || chat.chatID;
        if (!chatId) continue;

        const msgData = await this._api('GET', `/v1/chats/${encodeURIComponent(chatId)}/messages?limit=5`);
        const messages = msgData.items || [];

        // Messages are newest-first; process in reverse (oldest-first) for correct ordering
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          const msgId = Number(msg.id || msg.messageID);
          if (!msgId) continue;

          // Skip already-seen messages
          const lastSeen = this._lastSeen[chatId] || 0;
          if (msgId <= lastSeen) continue;

          // Update last seen
          this._lastSeen[chatId] = msgId;

          // Only process self-messages with command prefix
          const isSelf = this._isSelf(msg);
          const text = msg.text || '';

          // Skip our own responses to avoid cascade
          if (text.startsWith('[multis]')) continue;

          if (isSelf && text.startsWith(this.commandPrefix) && this._messageCallback) {
            console.log(`Beeper: command from ${chat.title || chatId}: ${text}`);

            const normalized = new Message({
              id: msgId,
              platform: 'beeper',
              chatId,
              chatName: chat.title || chat.name || '',
              senderId: msg.senderID || msg.sender || '',
              senderName: msg.senderName || '',
              isSelf: true,
              text,
              raw: msg,
            });

            try {
              await this._messageCallback(normalized, this);
            } catch (err) {
              console.error(`Beeper: handler error — ${err.message}`);
            }
          }
        }
      }

      // Clear poll error flag on success
      this._pollErrorLogged = false;
    } catch (err) {
      if (!this._pollErrorLogged) {
        console.error(`Beeper: poll error — ${err.message}`);
        this._pollErrorLogged = true;
      }
    }
  }

  _isSelf(msg) {
    const sender = msg.senderID || msg.sender || '';
    return this.selfIds.has(sender);
  }

  _loadToken() {
    try {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      return data.access_token;
    } catch {
      // Also check legacy location
      const legacyPath = path.join(__dirname, '..', '..', '.beeper-storage', 'desktop-token.json');
      try {
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        return data.access_token;
      } catch {
        return null;
      }
    }
  }

  async _api(method, apiPath, body) {
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${this.baseUrl}${apiPath}`, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return res.json();
  }
}

module.exports = { BeeperPlatform };
