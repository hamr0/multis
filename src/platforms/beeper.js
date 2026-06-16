const fs = require('fs');
const { Platform } = require('./base');
const { Message } = require('./message');
const { BeeperboxMcpClient } = require('./beeperbox-mcp');

const DEFAULT_MCP_URL = 'http://localhost:23375';  // beeperbox MCP transport (watch/send)
const DEFAULT_POLL_INTERVAL = 3000;
const MAX_PAGES_PER_TICK = 10; // has_more drain cap so one tick can't starve the loop
const { PATHS } = require('../config');

/**
 * Beeper platform adapter — consumes beeperbox's MCP watch/send verbs.
 *
 * Watch is a restart-resumable `poll_messages` cursor (replaces the old
 * /v1/chats walk + hand-rolled seed/dedup/gap-reseed). Echo-guard is
 * beeperbox's exact-id `source:"api"` tag (replaces the [multis] text prefix
 * + _isLooping heuristic). Sends carry a unique client_tag. Policy (modes,
 * personal-chat gating, command routing, owner) stays here — verbs live in
 * beeperbox, policy lives in multis (PRD §E).
 *
 * multis speaks ONLY the beeperbox MCP transport (:23375) — watch, send, chat
 * discovery (list_inbox), and asset bytes (download_asset). It no longer touches
 * the raw Desktop API (:23373) at all. Native (non-beeperbox) Beeper Desktop has
 * no MCP transport and is not a target of this adapter.
 */
class BeeperPlatform extends Platform {
  constructor(config) {
    super('beeper', config);
    const bc = config.platforms?.beeper || {};
    this.mcpUrl = bc.mcp_url || DEFAULT_MCP_URL;
    this.mcpToken = bc.mcp_token || process.env.MCP_AUTH_TOKEN || null;
    this.pollInterval = bc.poll_interval || DEFAULT_POLL_INTERVAL;
    this.commandPrefix = bc.command_prefix || '/';
    this.mcp = null;                    // BeeperboxMcpClient
    this._cursor = null;                // poll_messages opaque cursor (restart-safe)
    this._pollTimer = null;
    this._polling = false;              // overlap guard
    this._initialized = false;
    this._personalChats = new Set();    // chatIds that are note-to-self chats
    this._chatMeta = new Map();         // chatId -> { title, isNoteToSelf, network }
    this._botChatId = bc.bot_chat_id || null; // Telegram bot chat to exclude
    this._sendSeq = 0;                  // client_tag uniqueness within this process
  }

  async start() {
    this.mcp = new BeeperboxMcpClient({ url: this.mcpUrl, token: this.mcpToken });

    // Liveness + contract check against beeperbox MCP (container, local `node
    // mcp/server.js` lite mode, or remote — same verbs).
    try {
      const accounts = await this.mcp.listAccounts();
      const list = Array.isArray(accounts) ? accounts : accounts?.items || [];
      if (list.length === 0) {
        console.warn(`Beeper: beeperbox MCP reachable at ${this.mcpUrl} but 0 accounts connected — is Beeper logged in / are bridges linked? Watching will see nothing until an account exists.`);
      } else {
        const nets = list.map((a) => a.network || a.network_label).filter(Boolean).join(', ');
        console.log(`Beeper: connected via beeperbox MCP at ${this.mcpUrl} (${list.length} account(s): ${nets})`);
      }
    } catch (err) {
      const hint = (err.code === 401 || err.code === 403)
        ? 'auth failed — check platforms.beeper.mcp_token / MCP_AUTH_TOKEN'
        : 'unreachable — is beeperbox running? (container, `node mcp/server.js` lite mode, or remote)';
      console.error(`Beeper: beeperbox MCP at ${this.mcpUrl} ${hint} — ${err.message}`);
      return false;
    }

    // Seed the watch cursor: reuse a persisted one (restart-resumable, no
    // missed/duplicated messages), else seed "from now" via an empty poll.
    try {
      const saved = this._loadCursor();
      if (saved) {
        this._cursor = saved;
        console.log('Beeper: resumed watch cursor from disk');
      } else {
        const seed = await this.mcp.pollMessages({});
        this._cursor = seed.cursor;
        this._saveCursor();
        console.log('Beeper: seeded watch cursor (from now)');
      }
    } catch (err) {
      console.error(`Beeper: cursor seed error — ${err.message}`);
      return false;
    }
    this._initialized = true;

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
    // Unique client_tag → beeperbox tags the read-back source:"api" by exact id,
    // so our own send is skipped on the next poll. No [multis] text prefix.
    const client_tag = `multis-${process.pid}-${++this._sendSeq}`;
    await this.mcp.sendMessage({ chat_id: chatId, text, client_tag });
  }

  async _poll() {
    if (!this._initialized) return;
    if (this._polling) return; // prevent overlapping polls
    this._polling = true;
    try {
      // Drain the watch feed: poll_messages delivers oldest-first and advances
      // the cursor only past what it returned, so has_more means "more is
      // immediately fetchable" — keep going (bounded) before sleeping.
      for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
        const res = await this.mcp.pollMessages({ cursor: this._cursor });
        this._cursor = res.cursor;
        this._saveCursor();

        const messages = res.messages || [];
        for (const msg of messages) {
          await this._handleMessage(msg);
        }

        if (!res.has_more) break;
      }
      // Reset the log-once latch only after a fully clean tick — clearing it
      // per-page would re-log a recurring mid-drain failure every tick.
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

  /**
   * Apply multis policy to one normalized beeperbox message and route it.
   * Per-message try/catch keeps a handler error from wedging the drain loop;
   * the cursor still advances (at-most-once delivery, errors logged not retried).
   */
  async _handleMessage(msg) {
    const msgId = String(msg.id || '');
    if (!msgId) return;

    // Echo-guard: beeperbox tags messages it sent via send_message/note_to_self
    // as source:"api" (exact-id matched). Skip our own programmatic sends.
    if (msg.source === 'api') return;

    const chatId = msg.chat_id;
    if (!chatId) return;
    if (chatId === this._botChatId) return; // skip Telegram bot chat

    const meta = await this._chatMetaFor(chatId);
    if (meta.isNoteToSelf) this._personalChats.add(chatId);

    // Skip bot-to-bot chats by title heuristic (kept from the prior adapter).
    if (/bot$/i.test(meta.title) || /^bot/i.test(meta.title)) return;

    if (!this._messageCallback) return;

    const text = msg.text || '';
    const isSelf = msg.sender?.is_self === true;
    const isPersonalChat = this._personalChats.has(chatId);
    // A chat designated via /admin is a limited-admin command channel, even
    // though it isn't the owner's note-to-self. Treat it like a personal chat
    // for routing (commands + natural language), not as a customer.
    const isAdminChat = Array.isArray(this.config?.admins)
      && this.config.admins.map(String).includes(String(chatId));
    const mode = this._getChatMode(chatId);

    // Off mode: skip non-self messages entirely. Exception: self-messages in
    // personal chats always go through (commands + interactive replies).
    if (mode === 'off') {
      if (!isSelf) return;
      if (!isPersonalChat) return;
    }

    let routeAs = null;
    let shouldProcess = false;

    if (isSelf && isPersonalChat && text.startsWith(this.commandPrefix)) {
      // Explicit command from personal/note-to-self chat only
      shouldProcess = true;
    } else if (isSelf && isPersonalChat && !text.startsWith(this.commandPrefix)) {
      // Self-message in personal chat → natural language ask / interactive reply
      routeAs = 'natural';
      shouldProcess = true;
    } else if (isAdminChat && text.startsWith(this.commandPrefix)) {
      // Command from a designated limited-admin chat
      shouldProcess = true;
    } else if (isAdminChat) {
      // Natural language / interactive reply from a limited-admin chat
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

    if (!shouldProcess) return;

    console.log(`Beeper: ${routeAs || 'command'} from ${meta.title || chatId}: ${text.slice(0, 80)}`);

    const normalized = new Message({
      id: msgId,
      platform: 'beeper',
      chatId,
      chatName: meta.title || '',
      senderId: msg.sender?.id || '',
      senderName: msg.sender?.name || '',
      isSelf,
      text,
      raw: msg,
      routeAs,
      isAdminChat,
      network: msg.network || meta.network || '',
    });

    // Attachments: beeperbox (>=0.7.0) surfaces attachments[] on each message
    // ({file_name, mime_type, src_url, size, is_voice_note}). Map to multis's
    // _attachments shape (fileName/srcURL) that the handlers indexing pipeline
    // consumes; bytes are fetched on demand via the download_asset verb
    // (downloadAsset below), so doc-indexing works over a remote :23375-only
    // beeperbox too — no raw :23373 needed.
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
      normalized._attachments = msg.attachments.map((a) => ({
        fileName: a.file_name || '',
        srcURL: a.src_url || '',
        mimeType: a.mime_type || '',
        size: a.size,
        isVoiceNote: a.is_voice_note === true,
      }));
    }

    try {
      await this._messageCallback(normalized, this);
    } catch (err) {
      console.error(`Beeper: handler error — ${err.message}`);
    }
  }

  /**
   * Chat metadata (title, note-to-self flag, network) for routing. poll_messages
   * carries only chat_id/network per message, so the title + note-to-self flag
   * come from get_chat, cached on first sighting (these rarely/never change).
   */
  async _chatMetaFor(chatId) {
    const cached = this._chatMeta.get(chatId);
    if (cached) return cached;
    try {
      const c = await this.mcp.callTool('get_chat', { chat_id: chatId });
      const meta = {
        title: c?.title || '',
        isNoteToSelf: c?.is_note_to_self === true,
        network: c?.network || '',
      };
      this._chatMeta.set(chatId, meta);
      return meta;
    } catch (err) {
      // Don't cache failures — retry on the next sighting. Surface it: a
      // transient get_chat failure makes us treat the chat as non-personal for
      // this tick, which silently drops a self-command (it fails the
      // personal-chat gate). Logging makes that visible instead of mysterious.
      console.error(`Beeper: get_chat(${chatId}) failed — ${err.message}`);
      return { title: '', isNoteToSelf: false, network: '' };
    }
  }

  /**
   * Recent chats via beeperbox's `list_inbox` verb — for `/mode` chat
   * discovery (handlers.findBeeperChat). MCP, not raw `:23373`, so it works
   * against a remote beeperbox where only `:23375` is reachable. Excludes the
   * bot's own note-to-self chat (beeperbox does this). Normalized chat shape:
   * { id, title, network, is_group, is_note_to_self, last_message_at, unread_count }.
   */
  async listInbox(limit = 100) {
    const chats = await this.mcp.callTool('list_inbox', { limit });
    return Array.isArray(chats) ? chats : chats?.items || [];
  }

  _loadCursor() {
    try {
      const data = JSON.parse(fs.readFileSync(PATHS.beeperCursor(), 'utf8'));
      return data.cursor || null;
    } catch {
      return null;
    }
  }

  _saveCursor() {
    try {
      fs.writeFileSync(PATHS.beeperCursor(), JSON.stringify({ cursor: this._cursor, savedAt: new Date().toISOString() }));
    } catch (err) {
      if (!this._cursorSaveErrorLogged) {
        console.error(`Beeper: cursor persist failed — ${err.message}`);
        this._cursorSaveErrorLogged = true;
      }
    }
  }

  /**
   * Fetch an attachment's bytes via beeperbox's `download_asset` MCP verb.
   * The verb proxies Beeper's asset serve and returns the bytes base64-encoded
   * over the MCP line (:23375), so this works against a remote beeperbox where
   * the raw :23373 API is not reachable. Callers already hold the attachment's
   * file_name from _attachments, so we reference by src_url (bytes only).
   * @param {string} srcUrl - attachment src_url (mxc:// / localmxc:// / file://)
   * @returns {Promise<Buffer>} the attachment bytes
   */
  async downloadAsset(srcUrl) {
    const res = await this.mcp.callTool('download_asset', { src_url: srcUrl });
    if (!res || typeof res.data_base64 !== 'string') {
      throw new Error('download_asset returned no data');
    }
    return Buffer.from(res.data_base64, 'base64');
  }

  getAdminChatIds() {
    return [...this._personalChats];
  }

  _getChatMode(chatId) {
    const stored = this.config.chats?.[chatId]?.mode;
    // Ignore stale 'personal' values (was renamed to profile, not a valid mode)
    if (stored && stored !== 'personal') return stored;
    if (this.config.platforms?.beeper?.default_mode) return this.config.platforms.beeper.default_mode;
    // Personal chats (note-to-self) are admin command channels — never restrict
    if (this._personalChats.has(chatId)) return 'personal';
    const botMode = this.config.bot_mode || 'personal';
    return botMode === 'personal' ? 'silent' : 'business';
  }

}

module.exports = { BeeperPlatform };
