const fs = require('fs');
const path = require('path');
const { Platform } = require('./base');
const { Message } = require('./message');
const { logAudit } = require('../governance/audit');

const DEFAULT_URL = 'http://localhost:23373';
const DEFAULT_POLL_INTERVAL = 3000;
const { PATHS } = require('../config');

/**
 * Beeper Desktop API platform adapter.
 * Polls localhost:23373 for new messages, processes / commands from self in personal chats.
 */
class BeeperPlatform extends Platform {
  constructor(config) {
    super('beeper', config);
    const bc = config.platforms?.beeper || {};
    this.baseUrl = bc.url || DEFAULT_URL;
    this.pollInterval = bc.poll_interval || DEFAULT_POLL_INTERVAL;
    this.commandPrefix = bc.command_prefix || '/';
    this.token = null;
    this.selfIds = new Set(); // account user IDs to detect self-messages
    this._pollTimer = null;
    this._seen = new Set(); // message IDs we've already processed or seeded
    this._processing = new Set(); // message IDs currently being handled (dedup guard)
    this._initialized = false; // first poll seeds _lastSeen without processing
    this._personalChats = new Set(); // chatIds that are self/note-to-self chats
    this._botChatId = bc.bot_chat_id || null; // Telegram bot chat to exclude from polling
  }

  async start() {
    this.token = this._loadToken();
    if (!this.token) {
      console.error('Beeper: no token found. Run: node src/cli/setup-beeper.js');
      return false;
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
      return false;
    }

    // Seed _lastSeen with current message IDs so we don't process old messages
    try {
      await this._seedLastSeen();
    } catch (err) {
      console.error(`Beeper: seed error — ${err.message}`);
      return false;
    }
    this._initialized = true;

    // Start polling
    this._lastPollTime = Date.now();
    this._pollTimer = setInterval(() => this._poll(), this.pollInterval);
    console.log(`Beeper: polling every ${this.pollInterval}ms for / commands`);
    return true;
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
    const data = await this._api('GET', '/v1/chats?limit=20');
    const chats = data.items || [];
    for (const chat of chats) {
      const chatId = chat.id || chat.chatID;
      if (!chatId) continue;
      if (chatId === this._botChatId) continue; // skip Telegram bot chat

      // Detect self/note-to-self chats: all participants have isSelf=true
      const items = chat.participants?.items || chat.members?.items || [];
      if (items.length > 0 && items.every(p => p.isSelf)) {
        this._personalChats.add(chatId);
      }

      // Seed with limit=5 to match poll window — prevents reprocessing after restart
      const msgData = await this._api('GET', `/v1/chats/${encodeURIComponent(chatId)}/messages?limit=5`);
      const messages = msgData.items || [];
      for (const m of messages) {
        const id = String(m.id || m.messageID || '');
        if (id) this._seen.add(id);
      }
    }
    if (this._personalChats.size > 0) {
      console.log(`Beeper: detected ${this._personalChats.size} personal/self chat(s)`);
    }
  }

  async _poll() {
    if (!this._initialized) return;
    if (this._polling) return; // prevent overlapping polls
    this._polling = true;
    const now = Date.now();
    try {
      // Detect hibernate/sleep: if gap since last poll is >30s (expect ~3s), re-seed
      if (this._lastPollTime && (now - this._lastPollTime) > 30000) {
        console.log(`Beeper: poll gap detected (${Math.round((now - this._lastPollTime) / 1000)}s) — re-seeding`);
        try {
          await this._seedLastSeen();
          this._lastPollTime = now;
        } catch (err) {
          // Seed failed (Desktop still reconnecting) — don't update _lastPollTime
          // so next poll retries the re-seed instead of processing stale messages
          console.error(`Beeper: re-seed failed, will retry — ${err.message}`);
        }
        this._polling = false;
        return; // skip this cycle either way
      }

      const data = await this._api('GET', '/v1/chats?limit=20');
      const chats = data.items || [];

      for (const chat of chats) {
        const chatId = chat.id || chat.chatID;
        if (!chatId) continue;
        if (chatId === this._botChatId) continue; // skip Telegram bot chat

        const msgData = await this._api('GET', `/v1/chats/${encodeURIComponent(chatId)}/messages?limit=5`);
        const messages = msgData.items || [];

        // Messages are newest-first; process in reverse (oldest-first) for correct ordering
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          const msgId = String(msg.id || msg.messageID || '');
          if (!msgId) continue;

          // Skip already-seen or currently-processing messages
          if (this._seen.has(msgId)) continue;
          if (this._processing.has(msgId)) continue;

          // Mark as seen
          this._seen.add(msgId);

          const isSelf = this._isSelf(msg);
          const text = msg.text || '';

          // Skip our own responses, bot chats, and bot-to-bot loops
          if (text.startsWith('[multis]')) continue;
          const chatTitle = chat.title || chat.name || '';
          if (/bot$/i.test(chatTitle) || /^bot/i.test(chatTitle)) continue;
          if (this._isLooping(chatId, messages)) continue;

          if (!this._messageCallback) continue;

          // Detect self/personal chats (single participant or DM type)
          const isPersonalChat = this._personalChats.has(chatId);

          const mode = this._getChatMode(chatId);

          // Off mode: skip non-self messages entirely (no processing, no archiving)
          // Self messages: only allow commands in personal chats, skip everything else
          if (mode === 'off') {
            if (!isSelf) continue;
            if (!isPersonalChat || !text.startsWith(this.commandPrefix)) continue;
          }

          // Determine how to route this message
          let routeAs = null;
          let shouldProcess = false;

          if (isSelf && isPersonalChat && text.startsWith(this.commandPrefix)) {
            // Explicit command from personal/note-to-self chat only
            shouldProcess = true;
          } else if (isSelf && isPersonalChat && !text.startsWith(this.commandPrefix)) {
            // Self-message in personal/note-to-self chat → natural language ask
            routeAs = 'natural';
            shouldProcess = true;
          } else if (!isSelf && mode === 'business') {
            // Incoming message in a business-mode chat → auto-respond
            routeAs = 'business';
            shouldProcess = true;
          }
          // silent mode: archive to memory, no response
          if (!shouldProcess && mode === 'silent') {
            routeAs = 'silent';
            shouldProcess = true;
          }

          if (shouldProcess) {
            console.log(`Beeper: ${routeAs || 'command'} from ${chat.title || chatId}: ${text.slice(0, 80)}`);
            this._processing.add(msgId);

            const normalized = new Message({
              id: msgId,
              platform: 'beeper',
              chatId,
              chatName: chat.title || chat.name || '',
              senderId: msg.senderID || msg.sender || '',
              senderName: msg.senderName || '',
              isSelf,
              text,
              raw: msg,
              routeAs,
              network: chat.network || '',
            });

            // Pass through file attachments for indexing
            if (msg.attachments?.length > 0) {
              normalized._attachments = msg.attachments;
            }

            try {
              await this._messageCallback(normalized, this);
            } catch (err) {
              console.error(`Beeper: handler error — ${err.message}`);
            } finally {
              this._processing.delete(msgId);
            }
          }
        }
      }

      // Cap seen set to prevent unbounded growth (keep last 500)
      if (this._seen.size > 500) {
        const arr = [...this._seen];
        this._seen = new Set(arr.slice(-250));
      }

      this._lastPollTime = now;
      this._pollErrorLogged = false;
    } catch (err) {
      if (!this._pollErrorLogged) {
        console.error(`Beeper: poll error — ${err.message}`);
        this._pollErrorLogged = true;
      }
    } finally {
      this._polling = false;
    }
  }

  _isLooping(chatId, messages) {
    // If the 2 most recent messages in this chat are [multis] responses,
    // we're in a bot-to-bot loop — stop responding
    const recent = messages.slice(0, 2);
    const multisCount = recent.filter(m => (m.text || '').startsWith('[multis]')).length;
    return multisCount >= 2;
  }

  _isSelf(msg) {
    const sender = msg.senderID || msg.sender || '';
    return this.selfIds.has(sender);
  }

  /**
   * Download an asset from Beeper Desktop API.
   * @param {string} mxcUrl - mxc:// URI (possibly with encryptedFileInfoJSON param)
   * @returns {string} local file path
   */
  async downloadAsset(mxcUrl) {
    const result = await this._api('POST', '/v1/assets/download', { url: mxcUrl });
    if (result.error) throw new Error(`Download failed: ${result.error}`);
    // srcURL is "file:///path" — strip protocol
    return result.srcURL.replace(/^file:\/\//, '');
  }

  getAdminChatIds() {
    return [...this._personalChats];
  }

  _getChatMode(chatId) {
    const stored = this.config.chats?.[chatId]?.mode;
    // Ignore stale 'personal' values (was renamed to profile, not a valid mode)
    if (stored && stored !== 'personal') return stored;
    if (this.config.platforms?.beeper?.default_mode) return this.config.platforms.beeper.default_mode;
    // Personal chats (note-to-self) stay off; others default per bot_mode
    if (this._personalChats.has(chatId)) return 'off';
    const botMode = this.config.bot_mode || 'personal';
    return botMode === 'personal' ? 'silent' : 'business';
  }

  _loadToken() {
    try {
      const data = JSON.parse(fs.readFileSync(PATHS.beeperToken(), 'utf8'));
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
