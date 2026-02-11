const { logAudit } = require('../governance/audit');
const { addAllowedUser, isOwner, saveConfig } = require('../config');
const { execCommand, readFile, listSkills } = require('../skills/executor');
const { DocumentIndexer } = require('../indexer/index');
const { createLLMClient } = require('../llm/client');
const { buildRAGPrompt, buildMemorySystemPrompt } = require('../llm/prompts');
const { getMemoryManager } = require('../memory/manager');
const { runCapture } = require('../memory/capture');
const { PinManager, hashPin } = require('../security/pin');
const { detectInjection, logInjectionAttempt } = require('../security/injection');

/**
 * Check if a user is paired (allowed).
 * Works with both ctx (Telegram) and Message objects.
 */
function isPaired(msgOrCtx, config) {
  // Beeper: self-sent messages are always trusted (already filtered by platform)
  if (msgOrCtx.isSelf) return true;
  const userId = msgOrCtx.senderId !== undefined ? msgOrCtx.senderId : msgOrCtx.from?.id;
  return config.allowed_users.includes(userId);
}

// ---------------------------------------------------------------------------
// Platform-agnostic handlers (work with Message + Platform)
// ---------------------------------------------------------------------------

/**
 * Main message dispatcher for all platforms.
 * Takes a normalized Message and routes to the appropriate handler.
 */
function createMessageRouter(config) {
  const indexer = new DocumentIndexer();
  const memoryManagers = new Map();
  const pinManager = new PinManager(config);
  const escalationRetries = new Map(); // chatId -> retry count

  // Memory config defaults
  const memCfg = {
    recent_window: config.memory?.recent_window || 20,
    capture_threshold: config.memory?.capture_threshold || 20,
    ...config.memory
  };

  // Create LLM client if configured (null if no API key)
  let llm = null;
  try {
    if (config.llm?.apiKey || config.llm?.provider === 'ollama') {
      llm = createLLMClient(config.llm);
    }
  } catch (err) {
    console.warn(`LLM init skipped: ${err.message}`);
  }

  // Owner commands that require PIN auth
  const PIN_PROTECTED = new Set(['exec', 'read', 'index']);

  return async (msg, platform) => {
    // Handle Telegram document uploads
    if (msg._document) {
      await handleDocumentUpload(msg, platform, config, indexer);
      return;
    }

    // Natural language / business routing (set by platform adapter)
    if (msg.routeAs === 'natural' || msg.routeAs === 'business') {
      if (!isPaired(msg, config)) return;
      await routeAsk(msg, platform, config, indexer, llm, msg.text, memoryManagers, memCfg, escalationRetries);
      return;
    }

    // Check for PIN input (4-6 digit text from user with pending command)
    const text = msg.text || '';
    if (pinManager.hasPending(msg.senderId) && /^\d{4,6}$/.test(text.trim())) {
      const pending = pinManager.getPending(msg.senderId);
      if (!pending) {
        await platform.send(msg.chatId, 'PIN entry expired. Please re-send the command.');
        return;
      }

      // Handle PIN change flow
      if (pending.action === 'pin_change') {
        await handlePinChangeStep(msg, platform, config, pinManager, text.trim(), pending);
        return;
      }

      const result = pinManager.authenticate(msg.senderId, text.trim());
      if (!result.success) {
        await platform.send(msg.chatId, result.reason);
        if (result.locked) pinManager.clearPending(msg.senderId);
        return;
      }

      // PIN correct — execute the stored command
      await platform.send(msg.chatId, 'PIN accepted.');
      const stored = pending;
      pinManager.clearPending(msg.senderId);
      // Re-route the stored command
      msg = stored.msg;
      // Fall through to command handling below with stored command/args
      await executeCommand(stored.command, stored.args, msg, platform, config, indexer, llm, memoryManagers, memCfg, pinManager);
      return;
    }

    if (!msg.isCommand()) return;

    const parsed = msg.parseCommand();
    if (!parsed) return;

    const { command, args } = parsed;

    // Pairing: /start <code> (Telegram) or //start <code> (Beeper)
    if (command === 'start') {
      await routeStart(msg, platform, config, args);
      return;
    }

    // Auth check for all other commands
    if (!isPaired(msg, config)) {
      if (msg.platform === 'telegram') {
        await platform.send(msg.chatId, 'You are not paired. Send /start <pairing_code> to pair.');
      }
      return;
    }

    // PIN check for protected owner commands
    if (PIN_PROTECTED.has(command) && isOwner(msg.senderId, config)) {
      const authNeeded = pinManager.needsAuth(msg.senderId);
      if (authNeeded === 'locked') {
        await platform.send(msg.chatId, 'Account locked due to failed PIN attempts. Try again later.');
        return;
      }
      if (authNeeded === true) {
        pinManager.setPending(msg.senderId, { command, args, msg, platform });
        await platform.send(msg.chatId, 'Enter your PIN:');
        return;
      }
    }

    await executeCommand(command, args, msg, platform, config, indexer, llm, memoryManagers, memCfg, pinManager);
  };
}

async function executeCommand(command, args, msg, platform, config, indexer, llm, memoryManagers, memCfg, pinManager) {
    switch (command) {
      case 'status':
        await routeStatus(msg, platform, config);
        break;
      case 'unpair':
        await routeUnpair(msg, platform, config);
        break;
      case 'exec':
        await routeExec(msg, platform, config, args);
        break;
      case 'read':
        await routeRead(msg, platform, config, args);
        break;
      case 'index':
        await routeIndex(msg, platform, config, indexer, args);
        break;
      case 'search':
        await routeSearch(msg, platform, config, indexer, args);
        break;
      case 'docs':
        await routeDocs(msg, platform, config, indexer);
        break;
      case 'skills':
        await platform.send(msg.chatId, `Available skills:\n${listSkills()}`);
        break;
      case 'ask':
        await routeAsk(msg, platform, config, indexer, llm, args, memoryManagers, memCfg, escalationRetries);
        break;
      case 'memory':
        await routeMemory(msg, platform, config, memoryManagers);
        break;
      case 'forget':
        await routeForget(msg, platform, config, memoryManagers);
        break;
      case 'remember':
        await routeRemember(msg, platform, config, memoryManagers, args);
        break;
      case 'mode':
        await routeMode(msg, platform, config, args);
        break;
      case 'pin':
        await routePinChange(msg, platform, config, pinManager);
        break;
      case 'help':
        await routeHelp(msg, platform, config);
        break;
      default:
        // Telegram plain text (no recognized command) → implicit ask
        if (msg.platform === 'telegram' && !msg.text.startsWith('/')) {
          await routeAsk(msg, platform, config, indexer, llm, msg.text, memoryManagers, memCfg, escalationRetries);
        }
        break;
    }
}

async function routePinChange(msg, platform, config, pinManager) {
  if (!isOwner(msg.senderId, config)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  if (!pinManager.isEnabled()) {
    // No PIN set — go straight to setting new PIN
    pinManager.setPending(msg.senderId, { action: 'pin_change', step: 'new' });
    await platform.send(msg.chatId, 'No PIN set. Enter a new PIN (4-6 digits):');
    return;
  }

  // PIN is set — verify current first
  pinManager.setPending(msg.senderId, { action: 'pin_change', step: 'verify' });
  await platform.send(msg.chatId, 'Enter your current PIN:');
}

async function handlePinChangeStep(msg, platform, config, pinManager, pin, pending) {
  if (pending.step === 'verify') {
    const result = pinManager.authenticate(msg.senderId, pin);
    if (!result.success) {
      await platform.send(msg.chatId, result.reason);
      if (result.locked) pinManager.clearPending(msg.senderId);
      return;
    }
    pinManager.setPending(msg.senderId, { action: 'pin_change', step: 'new' });
    await platform.send(msg.chatId, 'Enter your new PIN (4-6 digits):');
  } else if (pending.step === 'new') {
    if (!/^\d{4,6}$/.test(pin)) {
      await platform.send(msg.chatId, 'PIN must be 4-6 digits. Try again:');
      return;
    }
    config.security.pin_hash = hashPin(pin);
    saveConfig(config);
    pinManager.clearPending(msg.senderId);
    await platform.send(msg.chatId, 'PIN updated successfully.');
    logAudit({ action: 'pin_change', user_id: msg.senderId });
  }
}

async function routeStart(msg, platform, config, code) {
  const userId = msg.senderId;
  const username = msg.senderName;

  if (isPaired(msg, config)) {
    await platform.send(msg.chatId, `Welcome back, ${username}! You're already paired.`);
    logAudit({ action: 'start', user_id: userId, username, status: 'already_paired' });
    return;
  }

  // On Telegram, also check deep link payload
  if (msg.platform === 'telegram' && msg.raw?.startPayload) {
    code = code || msg.raw.startPayload;
  }

  if (!code) {
    const prefix = msg.platform === 'telegram' ? '/' : '//';
    await platform.send(msg.chatId, `Send: ${prefix}start <pairing_code>`);
    logAudit({ action: 'start', user_id: userId, username, status: 'no_code' });
    return;
  }

  if (code.toUpperCase() === config.pairing_code.toUpperCase()) {
    addAllowedUser(userId);
    config.allowed_users.push(userId);
    if (!config.owner_id) config.owner_id = userId;
    const role = config.owner_id === userId ? 'owner' : 'user';
    await platform.send(msg.chatId, `Paired successfully as ${role}! Welcome, ${username}.`);
    logAudit({ action: 'pair', user_id: userId, username, status: 'success', platform: msg.platform });
  } else {
    await platform.send(msg.chatId, 'Invalid pairing code. Try again.');
    logAudit({ action: 'pair', user_id: userId, username, status: 'invalid_code' });
  }
}

async function routeStatus(msg, platform, config) {
  const owner = isOwner(msg.senderId, config);
  const info = [
    'multis bot v0.1.0',
    `Platform: ${msg.platform}`,
    `Role: ${owner ? 'owner' : 'user'}`,
    `Paired users: ${config.allowed_users.length}`,
    `LLM provider: ${config.llm.provider}`,
    `Governance: ${config.governance.enabled ? 'enabled' : 'disabled'}`
  ];
  await platform.send(msg.chatId, info.join('\n'));
}

async function routeUnpair(msg, platform, config) {
  const userId = msg.senderId;
  config.allowed_users = config.allowed_users.filter(id => id !== userId);
  saveConfig(config);

  const prefix = msg.platform === 'telegram' ? '/' : '//';
  await platform.send(msg.chatId, `Unpaired. Send ${prefix}start <code> to pair again.`);
  logAudit({ action: 'unpair', user_id: userId, status: 'success' });
}

async function routeExec(msg, platform, config, command) {
  if (!isOwner(msg.senderId, config)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  if (!command) {
    const prefix = msg.platform === 'telegram' ? '/' : '//';
    await platform.send(msg.chatId, `Usage: ${prefix}exec <command>`);
    return;
  }

  const result = execCommand(command, msg.senderId);

  if (result.denied) {
    await platform.send(msg.chatId, `Denied: ${result.reason}`);
    return;
  }
  if (result.needsConfirmation) {
    await platform.send(msg.chatId, `Command "${command}" requires confirmation.`);
    return;
  }

  await platform.send(msg.chatId, result.output);
}

async function routeRead(msg, platform, config, filePath) {
  if (!isOwner(msg.senderId, config)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  if (!filePath) {
    const prefix = msg.platform === 'telegram' ? '/' : '//';
    await platform.send(msg.chatId, `Usage: ${prefix}read <path>`);
    return;
  }

  const result = readFile(filePath, msg.senderId);

  if (result.denied) {
    await platform.send(msg.chatId, `Denied: ${result.reason}`);
    return;
  }

  await platform.send(msg.chatId, result.output);
}

async function routeIndex(msg, platform, config, indexer, args) {
  if (!isOwner(msg.senderId, config)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  if (!args) {
    const prefix = msg.platform === 'telegram' ? '/' : '//';
    await platform.send(msg.chatId, `Usage: ${prefix}index <path> <kb|admin>`);
    return;
  }

  // Parse: last token may be scope (kb or admin)
  const parts = args.trim().split(/\s+/);
  const validScopes = ['kb', 'admin'];
  let scope = null;
  let filePath;

  if (parts.length >= 2 && validScopes.includes(parts[parts.length - 1].toLowerCase())) {
    scope = parts.pop().toLowerCase();
    filePath = parts.join(' ');
  } else {
    filePath = parts.join(' ');
  }

  if (!scope) {
    await platform.send(msg.chatId, 'Please specify scope: kb (public knowledge base) or admin (owner-only).\nExample: /index ~/doc.pdf kb');
    return;
  }

  const expanded = filePath.replace(/^~/, process.env.HOME || process.env.USERPROFILE);

  try {
    await platform.send(msg.chatId, `Indexing: ${filePath} (scope: ${scope})...`);
    const count = await indexer.indexFile(expanded, scope);
    await platform.send(msg.chatId, `Indexed ${count} chunks from ${filePath} [${scope}]`);
  } catch (err) {
    await platform.send(msg.chatId, `Index error: ${err.message}`);
  }
}

async function routeSearch(msg, platform, config, indexer, query) {
  if (!query) {
    const prefix = msg.platform === 'telegram' ? '/' : '//';
    await platform.send(msg.chatId, `Usage: ${prefix}search <query>`);
    return;
  }

  const admin = isOwner(msg.senderId, config);
  const scopes = admin ? undefined : ['kb', `user:${msg.chatId}`];
  const results = indexer.search(query, 5, { scopes });

  if (results.length === 0) {
    await platform.send(msg.chatId, 'No results found.');
    return;
  }

  const formatted = results.map((r, i) => {
    const path = r.sectionPath.join(' > ') || r.name;
    const preview = r.content.slice(0, 200).replace(/\n/g, ' ');
    return `${i + 1}. [${r.documentType}] ${path}\n${preview}...`;
  });

  await platform.send(msg.chatId, formatted.join('\n\n'));
  logAudit({ action: 'search', user_id: msg.senderId, query, results: results.length });

  // Record access for ACT-R activation tracking
  if (results.length > 0) {
    try {
      indexer.store.recordSearchAccess(results.map(c => c.chunkId), query);
    } catch { /* non-critical */ }
  }
}

async function routeDocs(msg, platform, config, indexer) {
  const stats = indexer.getStats();
  const lines = [
    `Indexed documents: ${stats.indexedFiles}`,
    `Total chunks: ${stats.totalChunks}`
  ];
  for (const [type, count] of Object.entries(stats.byType)) {
    lines.push(`  ${type}: ${count} chunks`);
  }
  await platform.send(msg.chatId, lines.join('\n') || 'No documents indexed yet.');
}

async function routeAsk(msg, platform, config, indexer, llm, question, memoryManagers, memCfg, escalationRetries) {
  if (!question) {
    const prefix = msg.platform === 'telegram' ? '/' : '//';
    await platform.send(msg.chatId, `Usage: ${prefix}ask <question>`);
    return;
  }

  if (!llm) {
    await platform.send(msg.chatId, 'LLM not configured. Set an API key in ~/.multis/config.json or .env');
    return;
  }

  const admin = isOwner(msg.senderId, config);

  // Prompt injection detection for non-admin chats
  if (!admin && config.security?.prompt_injection_detection) {
    const injection = detectInjection(question);
    if (injection.flagged) {
      logInjectionAttempt({
        chatId: msg.chatId,
        senderId: msg.senderId,
        platform: msg.platform,
        text: question,
        patterns: injection.patterns
      });
      // Still answer — scoped data is the hard boundary
    }
  }

  const mem = memoryManagers ? getMemoryManager(memoryManagers, msg.chatId, { isAdmin: admin }) : null;

  try {
    // Record user message
    if (mem) {
      mem.appendMessage('user', question);
      mem.appendToLog('user', question);
    }

    // Search for relevant documents (scoped)
    const scopes = admin ? undefined : ['kb', `user:${msg.chatId}`];
    const chunks = indexer.search(question, 5, { scopes });

    // Business escalation for non-admin chats
    if (msg.routeAs === 'business' && !admin && escalationRetries) {
      const esc = config.business?.escalation || {};
      const keywords = esc.escalate_keywords || [];
      const maxRetries = esc.max_retries_before_escalate || 2;
      const questionLower = question.toLowerCase();
      const keywordMatch = keywords.some(k => questionLower.includes(k.toLowerCase()));

      if (keywordMatch) {
        // Immediate escalation on keyword
        await platform.send(msg.chatId, "I'm checking with the team on this. Someone will follow up shortly.");
        if (config.business?.admin_chat) {
          await platform.send(config.business.admin_chat, `[Escalation] Chat ${msg.chatId}: "${question}" (keyword match)`);
        }
        logAudit({ action: 'escalate', chatId: msg.chatId, reason: 'keyword', question });
        escalationRetries.delete(msg.chatId);
        return;
      }

      if (chunks.length === 0) {
        const retries = (escalationRetries.get(msg.chatId) || 0) + 1;
        escalationRetries.set(msg.chatId, retries);

        if (retries >= maxRetries) {
          await platform.send(msg.chatId, "I'm checking with the team on this. Someone will follow up shortly.");
          if (config.business?.admin_chat) {
            await platform.send(config.business.admin_chat, `[Escalation] Chat ${msg.chatId}: "${question}" (${retries} unanswered)`);
          }
          logAudit({ action: 'escalate', chatId: msg.chatId, reason: 'retries', retries, question });
          escalationRetries.delete(msg.chatId);
          return;
        }

        await platform.send(msg.chatId, "I don't have information on that. Could you rephrase or provide more details?");
        logAudit({ action: 'ask_clarify', chatId: msg.chatId, retries, question });
        return;
      }

      // Successful answer — reset retry counter
      escalationRetries.delete(msg.chatId);
    }

    // Build messages array from recent conversation
    const recent = mem ? mem.loadRecent() : [];
    const memoryMd = mem ? mem.loadMemory() : '';
    const system = buildMemorySystemPrompt(memoryMd, chunks);

    // Build messages array: recent history (excluding the just-appended user msg if already there)
    // Recent already includes the current user message from appendMessage above
    const messages = recent.map(m => ({ role: m.role, content: m.content }));

    // If no recent history (no memory manager), fall back to single-message
    let answer;
    if (messages.length > 0) {
      answer = await llm.generateWithMessages(messages, { system });
    } else {
      const ragPrompt = buildRAGPrompt(question, chunks);
      answer = await llm.generate(ragPrompt.user, { system: ragPrompt.system });
    }

    await platform.send(msg.chatId, answer);

    // Record assistant response
    if (mem) {
      mem.appendMessage('assistant', answer);
      mem.appendToLog('assistant', answer);
    }

    logAudit({ action: 'ask', user_id: msg.senderId, question, chunks: chunks.length, routeAs: msg.routeAs });

    // Record access for ACT-R activation tracking
    if (chunks.length > 0) {
      try {
        indexer.store.recordSearchAccess(chunks.map(c => c.chunkId), question);
      } catch { /* non-critical */ }
    }

    // Fire-and-forget capture if threshold reached
    if (mem && memCfg && mem.shouldCapture(memCfg.capture_threshold)) {
      const captureScope = admin ? 'admin' : `user:${msg.chatId}`;
      runCapture(msg.chatId, mem, llm, indexer, {
        keepLast: 5,
        scope: captureScope,
        maxSections: memCfg.memory_max_sections
      }).catch(err => {
        console.error(`[capture] Background error: ${err.message}`);
      });
    }
  } catch (err) {
    await platform.send(msg.chatId, `LLM error: ${err.message}`);
  }
}

async function routeMemory(msg, platform, config, memoryManagers) {
  const mem = getMemoryManager(memoryManagers, msg.chatId, { isAdmin: isOwner(msg.senderId, config) });
  const memory = mem.loadMemory();
  if (!memory.trim()) {
    await platform.send(msg.chatId, 'No memory notes for this chat yet.');
    return;
  }
  await platform.send(msg.chatId, `Memory notes:\n\n${memory}`);
}

async function routeForget(msg, platform, config, memoryManagers) {
  const mem = getMemoryManager(memoryManagers, msg.chatId, { isAdmin: isOwner(msg.senderId, config) });
  mem.clearMemory();
  await platform.send(msg.chatId, 'Memory cleared for this chat.');
  logAudit({ action: 'forget', user_id: msg.senderId, chatId: msg.chatId });
}

async function routeRemember(msg, platform, config, memoryManagers, note) {
  if (!note) {
    const prefix = msg.platform === 'telegram' ? '/' : '//';
    await platform.send(msg.chatId, `Usage: ${prefix}remember <note>`);
    return;
  }
  const mem = getMemoryManager(memoryManagers, msg.chatId, { isAdmin: isOwner(msg.senderId, config) });
  mem.appendMemory(note);
  await platform.send(msg.chatId, 'Noted.');
  logAudit({ action: 'remember', user_id: msg.senderId, chatId: msg.chatId, note });
}

async function routeMode(msg, platform, config, mode) {
  if (!mode || !['personal', 'business'].includes(mode.trim().toLowerCase())) {
    const prefix = msg.platform === 'telegram' ? '/' : '//';
    await platform.send(msg.chatId, `Usage: ${prefix}mode <personal|business>`);
    return;
  }

  mode = mode.trim().toLowerCase();
  if (!config.platforms) config.platforms = {};
  if (!config.platforms.beeper) config.platforms.beeper = {};
  if (!config.platforms.beeper.chat_modes) config.platforms.beeper.chat_modes = {};

  config.platforms.beeper.chat_modes[msg.chatId] = mode;
  saveConfig(config);

  await platform.send(msg.chatId, `Chat mode set to: ${mode}`);
  logAudit({ action: 'mode', user_id: msg.senderId, chatId: msg.chatId, mode });
}

async function routeHelp(msg, platform, config) {
  const prefix = msg.platform === 'telegram' ? '/' : '//';
  const cmds = [
    'multis commands:',
    `${prefix}ask <question> - Ask about indexed documents`,
    `${prefix}status - Bot info`,
    `${prefix}search <query> - Search indexed documents`,
    `${prefix}docs - Show indexing stats`,
    `${prefix}memory - Show conversation memory`,
    `${prefix}remember <note> - Save a note to memory`,
    `${prefix}forget - Clear conversation memory`,
    `${prefix}mode <personal|business> - Set chat mode (Beeper)`,
    `${prefix}skills - List available skills`,
    `${prefix}unpair - Remove pairing`,
    `${prefix}help - This message`,
    '',
    'Plain text messages are treated as questions.'
  ];
  if (isOwner(msg.senderId, config)) {
    cmds.splice(1, 0,
      `${prefix}exec <cmd> - Run a shell command (owner)`,
      `${prefix}read <path> - Read a file or directory (owner)`,
      `${prefix}index <path> <kb|admin> - Index a document (owner)`,
      `${prefix}pin - Change PIN (owner)`,
      'Send a file to index it (owner, Telegram only)'
    );
  }
  await platform.send(msg.chatId, cmds.join('\n'));
}

async function handleDocumentUpload(msg, platform, config, indexer) {
  if (!isPaired(msg, config)) return;
  if (!isOwner(msg.senderId, config)) {
    await platform.send(msg.chatId, 'Owner only. Documents not accepted from non-owners.');
    return;
  }

  const doc = msg._document;
  if (!doc) return;

  const filename = doc.file_name || 'unknown';
  const ext = filename.split('.').pop().toLowerCase();
  const supported = ['pdf', 'docx', 'md', 'txt'];

  if (!supported.includes(ext)) {
    await platform.send(msg.chatId, `Unsupported file type: .${ext}\nSupported: ${supported.join(', ')}`);
    return;
  }

  try {
    await platform.send(msg.chatId, `Downloading and indexing: ${filename}...`);
    const fileLink = await msg._telegram.getFileLink(doc.file_id);
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());

    const count = await indexer.indexBuffer(buffer, filename, 'kb');
    await platform.send(msg.chatId, `Indexed ${count} chunks from ${filename} [kb]`);
    logAudit({ action: 'index_upload', user_id: msg.senderId, filename, chunks: count });
  } catch (err) {
    await platform.send(msg.chatId, `Index error: ${err.message}`);
    logAudit({ action: 'index_error', user_id: msg.senderId, filename, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Legacy Telegraf-style handlers (kept for backward compat, delegates to above)
// ---------------------------------------------------------------------------

function handleStart(config) {
  return (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;

    if (isPaired(ctx, config)) {
      ctx.reply(`Welcome back, ${username}! You're already paired. Send me any message.`);
      logAudit({ action: 'start', user_id: userId, username, status: 'already_paired' });
      return;
    }

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
      config.allowed_users.push(userId);
      if (!config.owner_id) config.owner_id = userId;
      const role = config.owner_id === userId ? 'owner' : 'user';
      ctx.reply(`Paired successfully as ${role}! Welcome, ${username}.`);
      logAudit({ action: 'pair', user_id: userId, username, status: 'success' });
    } else {
      ctx.reply('Invalid pairing code. Try again.');
      logAudit({ action: 'pair', user_id: userId, username, status: 'invalid_code', code_given: code });
    }
  };
}

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

function handleExec(config) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;
    if (!isOwner(ctx.from.id, config)) { ctx.reply('Owner only command.'); return; }
    const text = ctx.message.text || '';
    const command = text.replace(/^\/exec\s*/, '').trim();
    if (!command) { ctx.reply('Usage: /exec <command>'); return; }
    const result = execCommand(command, ctx.from.id);
    if (result.denied) { ctx.reply(`Denied: ${result.reason}`); return; }
    if (result.needsConfirmation) { ctx.reply(`Command "${command}" requires confirmation.`); return; }
    ctx.reply(result.output);
  };
}

function handleRead(config) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;
    if (!isOwner(ctx.from.id, config)) { ctx.reply('Owner only command.'); return; }
    const text = ctx.message.text || '';
    const filePath = text.replace(/^\/read\s*/, '').trim();
    if (!filePath) { ctx.reply('Usage: /read <path>'); return; }
    const result = readFile(filePath, ctx.from.id);
    if (result.denied) { ctx.reply(`Denied: ${result.reason}`); return; }
    ctx.reply(result.output);
  };
}

function handleSkills(config) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;
    ctx.reply(`Available skills:\n${listSkills()}`);
  };
}

function handleHelp(config) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;
    const cmds = [
      'multis commands:',
      '/ask <question> - Ask about indexed documents',
      '/status - Bot info',
      '/search <query> - Search indexed documents',
      '/docs - Show indexing stats',
      '/skills - List available skills',
      '/unpair - Remove pairing',
      '/help - This message',
      '',
      'Plain text messages are treated as questions.'
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

function handleIndex(config, indexer) {
  return async (ctx) => {
    if (!isPaired(ctx, config)) return;
    if (!isOwner(ctx.from.id, config)) { ctx.reply('Owner only command.'); return; }
    const text = ctx.message.text || '';
    const filePath = text.replace(/^\/index\s*/, '').trim();
    if (!filePath) { ctx.reply('Usage: /index <path>'); return; }
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

function handleDocument(config, indexer) {
  return async (ctx) => {
    if (!isPaired(ctx, config)) return;
    if (!isOwner(ctx.from.id, config)) { ctx.reply('Owner only.'); return; }
    const doc = ctx.message.document;
    if (!doc) return;
    const filename = doc.file_name || 'unknown';
    const ext = filename.split('.').pop().toLowerCase();
    const supported = ['pdf', 'docx', 'md', 'txt'];
    if (!supported.includes(ext)) { ctx.reply(`Unsupported: .${ext}`); return; }
    try {
      ctx.reply(`Downloading and indexing: ${filename}...`);
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

function handleSearch(config, indexer) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;
    const text = ctx.message.text || '';
    const query = text.replace(/^\/search\s*/, '').trim();
    if (!query) { ctx.reply('Usage: /search <query>'); return; }
    const results = indexer.search(query, 5);
    if (results.length === 0) { ctx.reply('No results found.'); return; }
    const formatted = results.map((r, i) => {
      const p = r.sectionPath.join(' > ') || r.name;
      const preview = r.content.slice(0, 200).replace(/\n/g, ' ');
      return `${i + 1}. [${r.documentType}] ${p}\n${preview}...`;
    });
    ctx.reply(formatted.join('\n\n'));
    logAudit({ action: 'search', user_id: ctx.from.id, query, results: results.length });
  };
}

function handleDocs(config, indexer) {
  return (ctx) => {
    if (!isPaired(ctx, config)) return;
    const stats = indexer.getStats();
    const lines = [`Indexed documents: ${stats.indexedFiles}`, `Total chunks: ${stats.totalChunks}`];
    for (const [type, count] of Object.entries(stats.byType)) {
      lines.push(`  ${type}: ${count} chunks`);
    }
    ctx.reply(lines.join('\n') || 'No documents indexed yet.');
  };
}

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
    if (text.startsWith('/')) return;
    logAudit({ action: 'message', user_id: userId, username, text });
    ctx.reply(`Echo: ${text}`);
  };
}

module.exports = {
  // Platform-agnostic
  createMessageRouter,
  // Legacy Telegraf handlers
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
