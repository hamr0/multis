const { logAudit } = require('../governance/audit');
const { addAllowedUser, isOwner } = require('../config');
const { execCommand, readFile, listSkills } = require('../skills/executor');
const { DocumentIndexer } = require('../indexer/index');

/**
 * Check if a user is paired (allowed)
 */
function isPaired(ctx, config) {
  return config.allowed_users.includes(ctx.from.id);
}

/**
 * Handle /start command - entry point and pairing
 * Usage: /start <pairing_code>
 */
function handleStart(config) {
  return (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    // Already paired
    if (isPaired(ctx, config)) {
      ctx.reply(`Welcome back, ${username}! You're already paired. Send me any message.`);
      logAudit({ action: 'start', user_id: userId, username, status: 'already_paired' });
      return;
    }

    // Check for pairing code - Telegraf provides deep link payload via ctx.startPayload
    // Also check message text for manual /start <code> input
    const text = ctx.message.text || '';
    const parts = text.split(/\s+/);
    const code = ctx.startPayload || parts[1];

    if (!code) {
      ctx.reply('Send: /start <pairing_code>\nOr use deep link: t.me/multis02bot?start=<code>');
      logAudit({ action: 'start', user_id: userId, username, status: 'no_code' });
      return;
    }

    if (code.toUpperCase() === config.pairing_code.toUpperCase()) {
      addAllowedUser(userId);
      config.allowed_users.push(userId); // update in-memory too
      if (!config.owner_id) config.owner_id = userId; // first user = owner
      const role = config.owner_id === userId ? 'owner' : 'user';
      ctx.reply(`Paired successfully as ${role}! Welcome, ${username}.`);
      logAudit({ action: 'pair', user_id: userId, username, status: 'success' });
    } else {
      ctx.reply('Invalid pairing code. Try again.');
      logAudit({ action: 'pair', user_id: userId, username, status: 'invalid_code', code_given: code });
    }
  };
}

/**
 * Handle /status command - show bot info
 */
function handleStatus(config) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;

    const owner = isOwner(ctx.from.id, config);
    const info = [
      'multis bot v0.1.0',
      `Role: ${owner ? 'owner' : 'user'}`,
      `Paired users: ${config.allowed_users.length}`,
      `LLM provider: ${config.llm.provider}`,
      `Governance: ${config.governance.enabled ? 'enabled' : 'disabled'}`
    ];
    ctx.reply(info.join('\n'));
  };
}

/**
 * Handle /unpair command - remove self from allowed users
 */
function handleUnpair(config) {
  return (ctx) => {
    const userId = ctx.from.id;
    if (!isPaired(ctx, config)) return;

    config.allowed_users = config.allowed_users.filter(id => id !== userId);
    const { saveConfig } = require('../config');
    saveConfig(config);

    ctx.reply('Unpaired. Send /start <code> to pair again.');
    logAudit({ action: 'unpair', user_id: userId, status: 'success' });
  };
}

/**
 * Handle /exec command - run shell commands with governance
 * Usage: /exec ls -la ~/Documents
 */
function handleExec(config) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;
    if (!isOwner(ctx.from.id, config)) {
      ctx.reply('Owner only command.');
      return;
    }

    const text = ctx.message.text || '';
    const command = text.replace(/^\/exec\s*/, '').trim();

    if (!command) {
      ctx.reply('Usage: /exec <command>\nExample: /exec ls -la ~/Documents');
      return;
    }

    const result = execCommand(command, ctx.from.id);

    if (result.denied) {
      ctx.reply(`Denied: ${result.reason}`);
      return;
    }

    if (result.needsConfirmation) {
      ctx.reply(`Command "${command}" requires confirmation.\nThis feature is coming in a future update.`);
      return;
    }

    ctx.reply(result.output);
  };
}

/**
 * Handle /read command - read files with governance path checks
 * Usage: /read ~/Documents/notes.txt
 */
function handleRead(config) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;
    if (!isOwner(ctx.from.id, config)) {
      ctx.reply('Owner only command.');
      return;
    }

    const text = ctx.message.text || '';
    const filePath = text.replace(/^\/read\s*/, '').trim();

    if (!filePath) {
      ctx.reply('Usage: /read <path>\nExample: /read ~/Documents/notes.txt');
      return;
    }

    const result = readFile(filePath, ctx.from.id);

    if (result.denied) {
      ctx.reply(`Denied: ${result.reason}`);
      return;
    }

    ctx.reply(result.output);
  };
}

/**
 * Handle /skills command - list available skills
 */
function handleSkills(config) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;
    ctx.reply(`Available skills:\n${listSkills()}`);
  };
}

/**
 * Handle /help command - show available commands
 */
function handleHelp(config) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;
    const cmds = [
      'multis commands:',
      '/status - Bot info',
      '/search <query> - Search indexed documents',
      '/docs - Show indexing stats',
      '/skills - List available skills',
      '/unpair - Remove pairing',
      '/help - This message'
    ];
    if (isOwner(ctx.from.id, config)) {
      cmds.splice(1, 0,
        '/exec <cmd> - Run a shell command (owner)',
        '/read <path> - Read a file or directory (owner)',
        '/index <path> - Index a document (owner)',
        'Send a file to index it (owner)'
      );
    }
    ctx.reply(cmds.join('\n'));
  };
}

/**
 * Handle /index command - index a file path (owner only)
 * Usage: /index ~/Documents/report.pdf
 * Or send a document with /index as caption
 */
function handleIndex(config, indexer) {
  return async (ctx) => {
    if (!isPaired(ctx, config)) return;
    if (!isOwner(ctx.from.id, config)) {
      ctx.reply('Owner only command.');
      return;
    }

    const text = ctx.message.text || '';
    const filePath = text.replace(/^\/index\s*/, '').trim();

    if (!filePath) {
      ctx.reply('Usage: /index <path>\nOr send a document file with /index as caption.');
      return;
    }

    const expanded = filePath.replace(/^~/, process.env.HOME || process.env.USERPROFILE);

    try {
      ctx.reply(`Indexing: ${filePath}...`);
      const count = await indexer.indexFile(expanded);
      ctx.reply(`Indexed ${count} chunks from ${filePath}`);
    } catch (err) {
      ctx.reply(`Index error: ${err.message}`);
    }
  };
}

/**
 * Handle document file uploads (owner only)
 * User sends a PDF/DOCX/TXT/MD file to the bot
 */
function handleDocument(config, indexer) {
  return async (ctx) => {
    if (!isPaired(ctx, config)) return;
    if (!isOwner(ctx.from.id, config)) {
      ctx.reply('Owner only. Documents are not accepted from non-owners.');
      return;
    }

    const doc = ctx.message.document;
    if (!doc) return;

    const filename = doc.file_name || 'unknown';
    const ext = filename.split('.').pop().toLowerCase();
    const supported = ['pdf', 'docx', 'md', 'txt'];

    if (!supported.includes(ext)) {
      ctx.reply(`Unsupported file type: .${ext}\nSupported: ${supported.join(', ')}`);
      return;
    }

    try {
      ctx.reply(`Downloading and indexing: ${filename}...`);

      // Download file from Telegram
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const response = await fetch(fileLink.href);
      const buffer = Buffer.from(await response.arrayBuffer());

      const count = await indexer.indexBuffer(buffer, filename);
      ctx.reply(`Indexed ${count} chunks from ${filename}`);
      logAudit({ action: 'index_upload', user_id: ctx.from.id, filename, chunks: count });
    } catch (err) {
      ctx.reply(`Index error: ${err.message}`);
      logAudit({ action: 'index_error', user_id: ctx.from.id, filename, error: err.message });
    }
  };
}

/**
 * Handle /search command - BM25 search indexed documents
 * Usage: /search payment terms
 */
function handleSearch(config, indexer) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;

    const text = ctx.message.text || '';
    const query = text.replace(/^\/search\s*/, '').trim();

    if (!query) {
      ctx.reply('Usage: /search <query>\nExample: /search payment terms');
      return;
    }

    const results = indexer.search(query, 5);

    if (results.length === 0) {
      ctx.reply('No results found.');
      return;
    }

    const formatted = results.map((r, i) => {
      const path = r.sectionPath.join(' > ') || r.name;
      const preview = r.content.slice(0, 200).replace(/\n/g, ' ');
      return `${i + 1}. [${r.documentType}] ${path}\n${preview}...`;
    });

    ctx.reply(formatted.join('\n\n'));
    logAudit({ action: 'search', user_id: ctx.from.id, query, results: results.length });
  };
}

/**
 * Handle /docs command - show indexing stats
 */
function handleDocs(config, indexer) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;

    const stats = indexer.getStats();
    const lines = [
      `Indexed documents: ${stats.indexedFiles}`,
      `Total chunks: ${stats.totalChunks}`
    ];
    for (const [type, count] of Object.entries(stats.byType)) {
      lines.push(`  ${type}: ${count} chunks`);
    }
    ctx.reply(lines.join('\n') || 'No documents indexed yet.');
  };
}

/**
 * Handle all text messages - echo for POC1
 */
function handleMessage(config) {
  return (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    if (!isPaired(ctx, config)) {
      ctx.reply('You are not paired. Send /start <pairing_code> to pair.');
      logAudit({ action: 'message', user_id: userId, username, status: 'unpaired' });
      return;
    }

    const text = ctx.message.text;

    // Skip commands — they're handled by bot.command() / bot.start()
    if (text.startsWith('/')) return;

    logAudit({ action: 'message', user_id: userId, username, text });

    // POC1: Echo
    ctx.reply(`Echo: ${text}`);
  };
}

module.exports = {
  handleStart,
  handleStatus,
  handleUnpair,
  handleExec,
  handleRead,
  handleIndex,
  handleDocument,
  handleSearch,
  handleDocs,
  handleSkills,
  handleHelp,
  handleMessage,
  isPaired
};
