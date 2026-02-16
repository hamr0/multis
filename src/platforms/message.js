/**
 * Normalized message across all platforms.
 * Telegram bot messages are always commands.
 * Beeper messages are commands only when prefixed with / from personal chats.
 */
class Message {
  constructor({ id, platform, chatId, chatName, senderId, senderName, isSelf, text, raw, routeAs }) {
    this.id = id;
    this.platform = platform;
    this.chatId = chatId;
    this.chatName = chatName || '';
    this.senderId = senderId;
    this.senderName = senderName || '';
    this.isSelf = isSelf || false;
    this.text = text || '';
    this.raw = raw || null;
    /** @type {'natural'|'business'|null} Set by platform for non-command routing */
    this.routeAs = routeAs || null;
  }

  /**
   * Is this message a command for multis?
   * Telegram: all messages to the bot are commands (it's a dedicated bot).
   * Beeper: only messages starting with / are commands (restricted to personal chats by platform).
   */
  isCommand() {
    if (this.platform === 'telegram') return true;
    if (this.platform === 'beeper') return this.isSelf && this.text.startsWith('/');
    return false;
  }

  /**
   * Get the command text with platform prefix stripped.
   * Telegram: "/exec ls" -> "exec ls", plain text -> text as-is
   * Beeper: "/exec ls" -> "exec ls"
   */
  commandText() {
    if (this.platform === 'telegram') {
      return this.text.startsWith('/') ? this.text.slice(1) : this.text;
    }
    if (this.platform === 'beeper') {
      return this.text.startsWith('/') ? this.text.slice(1).trimStart() : this.text;
    }
    return this.text;
  }

  /**
   * Parse command name and arguments.
   * Returns { command, args } or null if not a command.
   */
  parseCommand() {
    if (!this.isCommand()) return null;
    const text = this.commandText();
    // Handle Telegram @bot suffix: /command@botname args
    const match = text.match(/^([^\s@]+)(?:@\S+)?(?:\s+(.*)|$)/s);
    if (!match) return null;
    return { command: match[1].toLowerCase(), args: match[2] };
  }
}

module.exports = { Message };
