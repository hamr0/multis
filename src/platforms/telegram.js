const { Telegraf } = require('telegraf');
const { Platform } = require('./base');
const { Message } = require('./message');
const { logAudit } = require('../governance/audit');
const { DocumentIndexer } = require('../indexer/index');

/**
 * Telegram platform adapter.
 * Wraps Telegraf bot, converts ctx to normalized Message objects.
 */
class TelegramPlatform extends Platform {
  constructor(config) {
    super('telegram', config);
    const token = config.platforms?.telegram?.bot_token || config.telegram_bot_token;
    if (!token) {
      throw new Error('Telegram bot token is required');
    }
    this.bot = new Telegraf(token);
    this.indexer = new DocumentIndexer();
  }

  async start() {
    // Wire up raw message handler that converts to Message objects
    this.bot.on('message', (ctx) => {
      if (!this._messageCallback) return;

      // Handle document uploads separately
      if (ctx.message.document) {
        this._handleDocument(ctx);
        return;
      }

      const text = ctx.message.text;
      if (!text) return;

      const msg = new Message({
        id: ctx.message.message_id,
        platform: 'telegram',
        chatId: ctx.chat.id,
        chatName: ctx.chat.title || ctx.chat.first_name || '',
        senderId: ctx.from.id,
        senderName: ctx.from.username || ctx.from.first_name || '',
        isSelf: false,
        text,
        raw: ctx,
      });

      this._messageCallback(msg, this);
    });

    this.bot.catch((err, ctx) => {
      console.error('Telegram error:', err.message);
      logAudit({ action: 'error', platform: 'telegram', error: err.message });
    });

    this.bot.launch({ dropPendingUpdates: true }).catch(err => {
      console.error('Telegram: launch error:', err.message);
    });
    console.log('Telegram: bot started');
  }

  async stop() {
    this.bot.stop('shutdown');
  }

  async send(chatId, text) {
    await this.bot.telegram.sendMessage(chatId, text);
  }

  /**
   * Handle document uploads - Telegram-specific (downloads file, indexes).
   * Calls the message callback with a special document Message.
   */
  async _handleDocument(ctx) {
    // Create message for auth check, then handle doc inline
    const msg = new Message({
      id: ctx.message.message_id,
      platform: 'telegram',
      chatId: ctx.chat.id,
      chatName: ctx.chat.title || '',
      senderId: ctx.from.id,
      senderName: ctx.from.username || ctx.from.first_name || '',
      isSelf: false,
      text: ctx.message.caption || '',
      raw: ctx,
    });
    msg._document = ctx.message.document;
    msg._indexer = this.indexer;
    msg._telegram = ctx.telegram;

    this._messageCallback(msg, this);
  }
}

module.exports = { TelegramPlatform };
