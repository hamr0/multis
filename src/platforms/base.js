/**
 * Abstract platform base class.
 * All platform adapters (Telegram, Beeper, etc.) extend this.
 */
class Platform {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this._messageCallback = null;
  }

  async start() {
    throw new Error(`${this.name}: start() not implemented`);
  }

  async stop() {
    throw new Error(`${this.name}: stop() not implemented`);
  }

  /**
   * Send a text message to a chat.
   * @param {string} chatId
   * @param {string} text
   */
  async send(chatId, text) {
    throw new Error(`${this.name}: send() not implemented`);
  }

  /**
   * Register callback for incoming messages.
   * Callback receives Message objects.
   */
  onMessage(callback) {
    this._messageCallback = callback;
  }
}

module.exports = { Platform };
