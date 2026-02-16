const path = require('path');
const { logAudit } = require('../governance/audit');
const { addAllowedUser, isOwner, saveConfig, getMultisDir } = require('../config');
const { execCommand, readFile, listSkills } = require('../skills/executor');
const { DocumentIndexer } = require('../indexer/index');
const { createLLMClient } = require('../llm/client');
const { buildRAGPrompt, buildMemorySystemPrompt } = require('../llm/prompts');
const { getMemoryManager } = require('../memory/manager');
const { runCapture } = require('../memory/capture');
const { PinManager, hashPin } = require('../security/pin');
const { detectInjection, logInjectionAttempt } = require('../security/injection');
const { buildToolRegistry, getToolsForUser, toLLMSchemas, loadToolsConfig } = require('../tools/registry');
const { executeTool } = require('../tools/executor');
const { getPlatform } = require('../tools/platform');

// ---------------------------------------------------------------------------
// Agent registry + resolution
// ---------------------------------------------------------------------------

/**
 * Build agent registry from config.agents.
 * Each agent: { llm, persona, model }. Reuses globalLlm when model matches.
 * Falls back to single-entry map with no persona if config.agents is missing/invalid.
 */
function buildAgentRegistry(config, globalLlm) {
  const fallback = new Map([['default', { llm: globalLlm, persona: null, model: config.llm?.model }]]);

  if (!config.agents) return fallback;

  if (typeof config.agents !== 'object' || Array.isArray(config.agents)) {
    console.error('Config error: "agents" must be an object. Falling back to default.');
    return fallback;
  }

  const registry = new Map();
  const globalModel = config.llm?.model;

  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent || typeof agent !== 'object') {
      console.warn(`Agent "${name}" invalid — skipping.`);
      continue;
    }
    if (!agent.persona) {
      console.warn(`Agent "${name}" missing persona — skipping.`);
      continue;
    }

    let agentLlm = globalLlm;
    if (agent.model && agent.model !== globalModel && globalLlm) {
      try {
        agentLlm = createLLMClient({ ...config.llm, model: agent.model });
      } catch (err) {
        console.warn(`Agent "${name}" LLM init failed (${err.message}) — using global.`);
      }
    }

    registry.set(name, { llm: agentLlm, persona: agent.persona, model: agent.model || globalModel });
  }

  if (registry.size === 0) {
    console.warn('No valid agents defined. Falling back to default.');
    return fallback;
  }

  return registry;
}

/**
 * Resolve which agent handles a message.
 * Order: @name prefix → per-chat assignment → mode default → first agent.
 */
function resolveAgent(text, chatId, config, agentRegistry) {
  // 1. @name prefix
  const mentionMatch = text.match(/^@(\S+)\s+([\s\S]*)$/);
  if (mentionMatch) {
    const name = mentionMatch[1].toLowerCase();
    if (agentRegistry.has(name)) {
      return { agent: agentRegistry.get(name), name, text: mentionMatch[2] };
    }
    // Unknown @mention — treat as plain text, fall through
  }

  // 2. Per-chat assignment
  const chatAgent = config.chat_agents?.[chatId];
  if (chatAgent && agentRegistry.has(chatAgent)) {
    return { agent: agentRegistry.get(chatAgent), name: chatAgent, text };
  }

  // 3. Mode-based default
  const mode = getChatMode(config, chatId);
  const modeDefault = config.defaults?.[mode];
  if (modeDefault && agentRegistry.has(modeDefault)) {
    return { agent: agentRegistry.get(modeDefault), name: modeDefault, text };
  }

  // 4. First agent in registry
  const firstName = agentRegistry.keys().next().value;
  return { agent: agentRegistry.get(firstName), name: firstName, text };
}

/**
 * Check if a user is paired (allowed).
 * Works with both ctx (Telegram) and Message objects.
 */
function isPaired(msgOrCtx, config) {
  // Beeper: self-sent messages are always trusted (already filtered by platform)
  if (msgOrCtx.isSelf) return true;
  const userId = String(msgOrCtx.senderId !== undefined ? msgOrCtx.senderId : msgOrCtx.from?.id);
  return config.allowed_users.map(String).includes(userId);
}

// ---------------------------------------------------------------------------
// Platform-agnostic handlers (work with Message + Platform)
// ---------------------------------------------------------------------------

/**
 * Main message dispatcher for all platforms.
 * Takes a normalized Message and routes to the appropriate handler.
 */
function createMessageRouter(config, deps = {}) {
  const indexer = deps.indexer || new DocumentIndexer();
  const memoryManagers = deps.memoryManagers || new Map();
  const _memBaseDir = deps.memoryBaseDir || path.join(getMultisDir(), 'memory', 'chats');
  const pinManager = deps.pinManager || new PinManager(config);
  const escalationRetries = deps.escalationRetries || new Map();

  // Helper: getMemoryManager with baseDir (follows getMultisDir for test isolation)
  const getMem = (chatId, opts = {}) =>
    getMemoryManager(memoryManagers, chatId, { ...opts, baseDir: _memBaseDir });

  // Memory config defaults
  const memCfg = {
    recent_window: config.memory?.recent_window || 20,
    capture_threshold: config.memory?.capture_threshold || 20,
    ...config.memory
  };

  // Create LLM client if configured (null if no API key)
  let llm = deps.llm || null;
  if (!llm) {
    try {
      if (config.llm?.apiKey || config.llm?.provider === 'ollama') {
        llm = createLLMClient(config.llm);
      }
    } catch (err) {
      console.warn(`LLM init skipped: ${err.message}`);
    }
  }

  // Build agent registry
  const agentRegistry = deps.agentRegistry || buildAgentRegistry(config, llm);

  // Build tool registry (platform-filtered, config-filtered)
  const toolsConfig = deps.toolsConfig || loadToolsConfig();
  const allTools = deps.tools || buildToolRegistry(toolsConfig);
  const runtimePlatform = deps.runtimePlatform || getPlatform();
  const maxToolRounds = config.llm?.max_tool_rounds || 5;

  // Owner commands that require PIN auth
  const PIN_PROTECTED = new Set(['exec', 'read', 'index']);

  return async (msg, platform) => {
    // Handle Telegram document uploads
    if (msg._document) {
      await handleDocumentUpload(msg, platform, config, indexer);
      return;
    }

    // Interactive replies (PIN, mode picker) must be checked before routeAs
    // so they aren't swallowed by natural/silent/business routing
    const text = msg.text || '';

    // Check for PIN input (4-6 digit text from user with pending command)
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
      await executeCommand(stored.command, stored.args, msg, platform, config, indexer, llm, memoryManagers, memCfg, pinManager, escalationRetries, agentRegistry, { allTools, toolsConfig, runtimePlatform, maxToolRounds });
      return;
    }

    // Handle pending mode selection (interactive picker reply)
    if (config._pendingMode?.[msg.senderId] && /^\d+$/.test(text.trim())) {
      const pending = config._pendingMode[msg.senderId];
      const idx = parseInt(text.trim(), 10) - 1;
      if (idx >= 0 && idx < pending.matches.length) {
        const chat = pending.matches[idx];
        setChatMode(config, chat.id, pending.mode);
        if (pending.agent) {
          if (!config.chat_agents) config.chat_agents = {};
          config.chat_agents[chat.id] = pending.agent;
          saveConfig(config);
        }
        delete config._pendingMode[msg.senderId];
        const agentNote = pending.agent ? `, agent: ${pending.agent}` : '';
        await platform.send(msg.chatId, `${chat.title || chat.id} set to: ${pending.mode}${agentNote}`);
        logAudit({ action: 'mode', user_id: msg.senderId, chatId: chat.id, mode: pending.mode, agent: pending.agent });
      } else {
        await platform.send(msg.chatId, `Invalid choice. Pick 1-${pending.matches.length}.`);
      }
      return;
    }
    // Clear stale pending mode if user sends something else
    if (config._pendingMode?.[msg.senderId]) {
      delete config._pendingMode[msg.senderId];
    }

    // Silent mode: archive to memory, no response
    if (msg.routeAs === 'silent') {
      const mem = getMem(msg.chatId, { isAdmin: false });
      if (mem) {
        const role = msg.isSelf ? 'user' : 'contact';
        mem.appendMessage(role, msg.text);
        mem.appendToLog(role, msg.text);
      }
      return;
    }

    // Natural language / business routing (set by platform adapter)
    if (msg.routeAs === 'natural' || msg.routeAs === 'business') {
      if (!isPaired(msg, config)) return;
      await routeAsk(msg, platform, config, indexer, llm, msg.text, getMem, memCfg, escalationRetries, agentRegistry, { allTools, toolsConfig, runtimePlatform, maxToolRounds });
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
    if (PIN_PROTECTED.has(command) && isOwner(msg.senderId, config, msg)) {
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

    await executeCommand(command, args, msg, platform, config, indexer, llm, getMem, memCfg, pinManager, escalationRetries, agentRegistry, { allTools, toolsConfig, runtimePlatform, maxToolRounds });
  };
}

async function executeCommand(command, args, msg, platform, config, indexer, llm, getMem, memCfg, pinManager, escalationRetries, agentRegistry, toolDeps) {
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
        await routeAsk(msg, platform, config, indexer, llm, args, getMem, memCfg, escalationRetries, agentRegistry, toolDeps);
        break;
      case 'memory':
        await routeMemory(msg, platform, config, getMem);
        break;
      case 'forget':
        await routeForget(msg, platform, config, getMem);
        break;
      case 'remember':
        await routeRemember(msg, platform, config, getMem, args);
        break;
      case 'mode':
        await routeMode(msg, platform, config, args, agentRegistry);
        break;
      case 'agent':
        await routeAgent(msg, platform, config, args, agentRegistry);
        break;
      case 'agents':
        await routeAgents(msg, platform, agentRegistry);
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
          await routeAsk(msg, platform, config, indexer, llm, msg.text, getMem, memCfg, escalationRetries, agentRegistry, toolDeps);
        }
        break;
    }
}

async function routePinChange(msg, platform, config, pinManager) {
  if (!isOwner(msg.senderId, config, msg)) {
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
    await platform.send(msg.chatId, 'Send: /start <pairing_code>');
    logAudit({ action: 'start', user_id: userId, username, status: 'no_code' });
    return;
  }

  if (code.toUpperCase() === config.pairing_code.toUpperCase()) {
    const id = String(userId);
    addAllowedUser(id);
    if (!config.allowed_users.map(String).includes(id)) {
      config.allowed_users.push(id);
    }
    if (!config.owner_id) config.owner_id = id;
    const role = String(config.owner_id) === id ? 'owner' : 'user';
    await platform.send(msg.chatId, `Paired successfully as ${role}! Welcome, ${username}.`);
    logAudit({ action: 'pair', user_id: id, username, status: 'success', platform: msg.platform });
  } else {
    await platform.send(msg.chatId, 'Invalid pairing code. Try again.');
    logAudit({ action: 'pair', user_id: userId, username, status: 'invalid_code' });
  }
}

async function routeStatus(msg, platform, config) {
  const owner = isOwner(msg.senderId, config, msg);
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

  await platform.send(msg.chatId, 'Unpaired. Send /start <code> to pair again.');
  logAudit({ action: 'unpair', user_id: userId, status: 'success' });
}

async function routeExec(msg, platform, config, command) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  if (!command) {
    await platform.send(msg.chatId, 'Usage: /exec <command>');
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
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  if (!filePath) {
    await platform.send(msg.chatId, 'Usage: /read <path>');
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
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  if (!args) {
    await platform.send(msg.chatId, 'Usage: /index <path> <public|admin>');
    return;
  }

  // Parse: last token may be role (public, kb, or admin)
  const parts = args.trim().split(/\s+/);
  const validRoles = ['public', 'kb', 'admin'];
  let role = null;
  let filePath;

  if (parts.length >= 2 && validRoles.includes(parts[parts.length - 1].toLowerCase())) {
    role = parts.pop().toLowerCase();
    // Accept old 'kb' as alias for 'public'
    if (role === 'kb') role = 'public';
    filePath = parts.join(' ');
  } else {
    filePath = parts.join(' ');
  }

  if (!role) {
    await platform.send(msg.chatId, 'Please specify role: public (knowledge base) or admin (owner-only).\nExample: /index ~/doc.pdf public');
    return;
  }

  const expanded = filePath.replace(/^~/, process.env.HOME || process.env.USERPROFILE);

  try {
    await platform.send(msg.chatId, `Indexing: ${filePath} (role: ${role})...`);
    const count = await indexer.indexFile(expanded, role);
    await platform.send(msg.chatId, `Indexed ${count} chunks from ${filePath} [${role}]`);
  } catch (err) {
    await platform.send(msg.chatId, `Index error: ${err.message}`);
  }
}

async function routeSearch(msg, platform, config, indexer, query) {
  if (!query) {
    await platform.send(msg.chatId, 'Usage: /search <query>');
    return;
  }

  const admin = isOwner(msg.senderId, config, msg);
  const roles = admin ? undefined : ['public', `user:${msg.chatId}`];
  const results = indexer.search(query, 5, { roles });

  if (results.length === 0) {
    await platform.send(msg.chatId, 'No results found.');
    return;
  }

  const formatted = results.map((r, i) => {
    const path = r.sectionPath.join(' > ') || r.name;
    const preview = r.content.slice(0, 200).replace(/\n/g, ' ');
    return `${i + 1}. [${r.element}] ${path}\n${preview}...`;
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

/**
 * Agent loop — calls LLM with tools, executes tool calls, feeds results back.
 * Loops until LLM returns text-only or max rounds reached.
 * @returns {Promise<string>} — final text answer
 */
async function runAgentLoop(llm, messages, toolSchemas, tools, opts = {}) {
  const { system, maxRounds = 5, ctx } = opts;
  const loopMessages = [...messages];

  for (let round = 0; round < maxRounds; round++) {
    const response = await llm.generateWithToolsAndMessages(loopMessages, toolSchemas, { system });
    const parsed = llm.parseToolResponse(response);

    // No tool calls — return the text
    if (!parsed.toolCalls || parsed.toolCalls.length === 0) {
      return parsed.text || '(no response)';
    }

    // Add assistant message to conversation
    loopMessages.push(llm.formatAssistantMessage(response));

    // Execute each tool call and feed results back
    for (const tc of parsed.toolCalls) {
      const result = await executeTool(tc, tools, ctx);
      loopMessages.push(llm.formatToolResult(tc.id, result));
    }

    // If the LLM also returned text alongside tool calls, we continue
    // to let it process the tool results
  }

  // Max rounds reached — do one final text-only call
  const finalResponse = await llm.generateWithMessages(loopMessages, { system });
  return finalResponse || '(max tool rounds reached)';
}

async function routeAsk(msg, platform, config, indexer, llm, question, getMem, memCfg, escalationRetries, agentRegistry, toolDeps = {}) {
  if (!question) {
    await platform.send(msg.chatId, 'Usage: /ask <question>');
    return;
  }

  if (!llm) {
    await platform.send(msg.chatId, 'LLM not configured. Set an API key in ~/.multis/config.json or .env');
    return;
  }

  const admin = isOwner(msg.senderId, config, msg);

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

  const mem = getMem ? getMem(msg.chatId, { isAdmin: admin }) : null;

  try {
    // Record user message
    if (mem) {
      mem.appendMessage('user', question);
      mem.appendToLog('user', question);
    }

    // Search for relevant documents (scoped)
    const roles = admin ? undefined : ['public', `user:${msg.chatId}`];
    const chunks = indexer.search(question, 5, { roles });

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

    // Resolve agent (handles @mention, per-chat, mode default, fallback)
    const resolved = agentRegistry && agentRegistry.size > 0
      ? resolveAgent(question, msg.chatId, config, agentRegistry)
      : { agent: { llm, persona: null }, name: 'default', text: question };
    const agentLlm = resolved.agent.llm || llm;
    const agentPersona = resolved.agent.persona;
    const cleanQuestion = resolved.text;

    // Build messages array from recent conversation
    const recent = mem ? mem.loadRecent() : [];
    const memoryMd = mem ? mem.loadMemory() : '';
    const system = buildMemorySystemPrompt(memoryMd, chunks, agentPersona);

    // Build messages array: recent history (excluding the just-appended user msg if already there)
    // Recent already includes the current user message from appendMessage above
    const messages = recent.map(m => ({ role: m.role, content: m.content }));

    // If @mention stripped the question, update the last message in recent
    if (cleanQuestion !== question && messages.length > 0) {
      messages[messages.length - 1] = { role: 'user', content: cleanQuestion };
    }

    // If no recent history (no memory manager), fall back to single-message
    if (messages.length === 0) {
      messages.push({ role: 'user', content: cleanQuestion });
    }

    // --- Agent loop with tool calling ---
    const { allTools = [], toolsConfig: tCfg, runtimePlatform, maxToolRounds = 5 } = toolDeps;
    const userTools = getToolsForUser(allTools, admin, tCfg);
    const toolSchemas = toLLMSchemas(userTools);
    const hasTools = toolSchemas.length > 0 && agentLlm.generateWithToolsAndMessages;

    let answer;
    if (hasTools) {
      answer = await runAgentLoop(agentLlm, messages, toolSchemas, userTools, {
        system,
        maxRounds: maxToolRounds,
        ctx: { senderId: msg.senderId, chatId: msg.chatId, isOwner: admin, runtimePlatform, indexer, memoryManager: mem, platform }
      });
    } else {
      answer = await agentLlm.generateWithMessages(messages, { system });
    }

    // Prefix with agent name only when multiple agents exist
    const prefixed = agentRegistry && agentRegistry.size > 1
      ? `[${resolved.name}] ${answer}`
      : answer;

    await platform.send(msg.chatId, prefixed);

    // Record assistant response (without prefix for clean memory)
    if (mem) {
      mem.appendMessage('assistant', answer);
      mem.appendToLog('assistant', answer);
    }

    logAudit({ action: 'ask', user_id: msg.senderId, question, chunks: chunks.length, routeAs: msg.routeAs, agent: resolved.name });

    // Record access for ACT-R activation tracking
    if (chunks.length > 0) {
      try {
        indexer.store.recordSearchAccess(chunks.map(c => c.chunkId), question);
      } catch { /* non-critical */ }
    }

    // Fire-and-forget capture if threshold reached
    if (mem && memCfg && mem.shouldCapture(memCfg.capture_threshold)) {
      const captureRole = admin ? 'admin' : `user:${msg.chatId}`;
      runCapture(msg.chatId, mem, llm, indexer, {
        keepLast: 5,
        role: captureRole,
        maxSections: memCfg.memory_max_sections
      }).catch(err => {
        console.error(`[capture] Background error: ${err.message}`);
      });
    }
  } catch (err) {
    await platform.send(msg.chatId, `LLM error: ${err.message}`);
  }
}

async function routeMemory(msg, platform, config, getMem) {
  const mem = getMem(msg.chatId, { isAdmin: isOwner(msg.senderId, config, msg) });
  const memory = mem.loadMemory();
  if (!memory.trim()) {
    await platform.send(msg.chatId, 'No memory notes for this chat yet.');
    return;
  }
  await platform.send(msg.chatId, `Memory notes:\n\n${memory}`);
}

async function routeForget(msg, platform, config, getMem) {
  const mem = getMem(msg.chatId, { isAdmin: isOwner(msg.senderId, config, msg) });
  mem.clearMemory();
  await platform.send(msg.chatId, 'Memory cleared for this chat.');
  logAudit({ action: 'forget', user_id: msg.senderId, chatId: msg.chatId });
}

async function routeRemember(msg, platform, config, getMem, note) {
  if (!note) {
    await platform.send(msg.chatId, 'Usage: /remember <note>');
    return;
  }
  const mem = getMem(msg.chatId, { isAdmin: isOwner(msg.senderId, config, msg) });
  mem.appendMemory(note);
  await platform.send(msg.chatId, 'Noted.');
  logAudit({ action: 'remember', user_id: msg.senderId, chatId: msg.chatId, note });
}

const VALID_MODES = ['off', 'business', 'silent'];

async function routeMode(msg, platform, config, args, agentRegistry) {
  // Owner-only
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  const parts = (args || '').trim().split(/\s+/);
  const mode = parts[0] ? parts[0].toLowerCase() : '';

  // No args → list chats with current modes (read-only, no PIN needed)
  if (!mode) {
    if (msg.platform === 'beeper' && platform._api) {
      const allChats = await listBeeperChats(platform);
      if (!allChats || allChats.length === 0) {
        await platform.send(msg.chatId, 'No chats found.');
        return;
      }
      const lines = allChats.map(c => {
        const m = getChatMode(config, c.id);
        return `  ${c.title || c.id} [${m}]`;
      });
      await platform.send(msg.chatId, `Chat modes:\n${lines.join('\n')}`);
    } else {
      // Telegram: show current chat mode
      const m = getChatMode(config, msg.chatId);
      await platform.send(msg.chatId, `Current chat mode: ${m}\n\nUsage: /mode <off|business|silent> [target]`);
    }
    return;
  }

  if (!VALID_MODES.includes(mode)) {
    await platform.send(msg.chatId,
      'Usage: /mode <off|business|silent> [target]\n\n' +
      'Modes:\n' +
      '  off      — completely ignored (no archive, no response)\n' +
      '  business — auto-respond, customer-safe\n' +
      '  silent   — archive only, no bot output\n\n' +
      'From self-chat: /mode silent (interactive picker)\n' +
      'From self-chat: /mode silent John (search by name)\n' +
      'In any chat: /mode business (sets current chat)'
    );
    return;
  }

  // Check if second arg is an agent name (optional)
  let agentArg = null;
  let target = '';
  if (parts.length >= 2 && agentRegistry && agentRegistry.has(parts[1].toLowerCase())) {
    agentArg = parts[1].toLowerCase();
    target = parts.slice(2).join(' ');
  } else {
    target = parts.slice(1).join(' ');
  }

  // Helper: assign agent to the resolved target chat (not the command source)
  function assignAgent(chatId) {
    if (agentArg) {
      if (!config.chat_agents) config.chat_agents = {};
      config.chat_agents[chatId] = agentArg;
      saveConfig(config);
    }
  }

  // If on Telegram, always set current chat (1:1 with bot)
  if (msg.platform === 'telegram') {
    setChatMode(config, msg.chatId, mode);
    assignAgent(msg.chatId);
    const agentNote = agentArg ? `, agent: ${agentArg}` : '';
    await platform.send(msg.chatId, `Chat mode set to: ${mode}${agentNote}`);
    logAudit({ action: 'mode', user_id: msg.senderId, chatId: msg.chatId, mode, agent: agentArg });
    return;
  }

  // Beeper: if target specified, search for chat by name/number
  if (target) {
    const match = await findBeeperChat(platform, target);
    if (!match) {
      await platform.send(msg.chatId, `No chat found matching "${target}".`);
      return;
    }
    if (match.length > 1) {
      const list = match.map((c, i) => `  ${i + 1}) ${c.title || c.name || c.id}`).join('\n');
      // Store pending mode selection (include agent for deferred assignment)
      if (!config._pendingMode) config._pendingMode = {};
      config._pendingMode[msg.senderId] = { mode, matches: match, agent: agentArg };
      await platform.send(msg.chatId, `Multiple matches:\n${list}\n\nReply with a number:`);
      return;
    }
    const chat = match[0];
    setChatMode(config, chat.id, mode);
    assignAgent(chat.id);
    const agentNote = agentArg ? `, agent: ${agentArg}` : '';
    await platform.send(msg.chatId, `${chat.title || chat.id} set to: ${mode}${agentNote}`);
    logAudit({ action: 'mode', user_id: msg.senderId, chatId: chat.id, mode, target, agent: agentArg });
    return;
  }

  // Beeper: no target — if in self-chat, show interactive picker
  if (msg.isSelf) {
    const allChats = await listBeeperChats(platform);
    if (!allChats || allChats.length === 0) {
      await platform.send(msg.chatId, 'No chats found.');
      return;
    }
    // Exclude the current chat (command channel) from the picker
    const chats = allChats.filter(c => c.id !== msg.chatId);
    const list = chats.map((c, i) => {
      const currentMode = getChatMode(config, c.id);
      return `  ${i + 1}) ${c.title || c.name || c.id} [${currentMode}]`;
    }).join('\n');
    // Store pending mode selection (include agent for deferred assignment)
    if (!config._pendingMode) config._pendingMode = {};
    config._pendingMode[msg.senderId] = { mode, matches: chats, agent: agentArg };
    await platform.send(msg.chatId, `Pick a chat to set to ${mode}:\n${list}\n\nReply with a number:`);
    return;
  }

  // Beeper: no target, not self-chat — set current chat
  setChatMode(config, msg.chatId, mode);
  assignAgent(msg.chatId);
  const agentNote = agentArg ? `, agent: ${agentArg}` : '';
  await platform.send(msg.chatId, `Chat mode set to: ${mode}${agentNote}`);
  logAudit({ action: 'mode', user_id: msg.senderId, chatId: msg.chatId, mode, agent: agentArg });
}

function setChatMode(config, chatId, mode) {
  if (!config.platforms) config.platforms = {};
  if (!config.platforms.beeper) config.platforms.beeper = {};
  if (!config.platforms.beeper.chat_modes) config.platforms.beeper.chat_modes = {};
  config.platforms.beeper.chat_modes[chatId] = mode;
  saveConfig(config);
}

function getChatMode(config, chatId) {
  const modes = config.platforms?.beeper?.chat_modes;
  if (modes && modes[chatId]) return modes[chatId];
  if (config.platforms?.beeper?.default_mode) return config.platforms.beeper.default_mode;
  // Default: personal bot_mode → silent for Beeper chats, business → business
  const botMode = config.bot_mode || 'personal';
  return botMode === 'personal' ? 'silent' : 'business';
}

async function listBeeperChats(platform) {
  if (!platform._api) return null;
  try {
    const data = await platform._api('GET', '/v1/chats?limit=20');
    const chats = data.items || [];
    return chats.map(c => ({
      id: c.id || c.chatID,
      title: c.title || c.name || '',
      network: c.network || '',
    })).filter(c => c.id);
  } catch {
    return null;
  }
}

async function findBeeperChat(platform, search) {
  const chats = await listBeeperChats(platform);
  if (!chats) return null;
  const q = search.toLowerCase();
  const matches = chats.filter(c =>
    (c.title && c.title.toLowerCase().includes(q)) ||
    (c.id && c.id.toLowerCase().includes(q))
  );
  return matches.length > 0 ? matches : null;
}

async function routeAgent(msg, platform, config, args, agentRegistry) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  const name = (args || '').trim().toLowerCase();

  if (!name) {
    // Show current agent for this chat
    const current = config.chat_agents?.[msg.chatId];
    if (current && agentRegistry.has(current)) {
      await platform.send(msg.chatId, `Current agent: ${current}`);
    } else {
      const firstName = agentRegistry.keys().next().value;
      await platform.send(msg.chatId, `Current agent: ${firstName} (default)`);
    }
    return;
  }

  if (!agentRegistry.has(name)) {
    const available = [...agentRegistry.keys()].join(', ');
    await platform.send(msg.chatId, `Unknown agent "${name}". Available: ${available}`);
    return;
  }

  if (!config.chat_agents) config.chat_agents = {};
  config.chat_agents[msg.chatId] = name;
  saveConfig(config);
  await platform.send(msg.chatId, `Agent set to: ${name}`);
  logAudit({ action: 'agent', user_id: msg.senderId, chatId: msg.chatId, agent: name });
}

async function routeAgents(msg, platform, agentRegistry) {
  const lines = ['Agents:'];
  for (const [name, agent] of agentRegistry) {
    const model = agent.model || 'default';
    const preview = agent.persona ? agent.persona.slice(0, 60) : '(no persona)';
    lines.push(`  ${name} [${model}] — ${preview}`);
  }
  await platform.send(msg.chatId, lines.join('\n'));
}

async function routeHelp(msg, platform, config) {
  const cmds = [
    'multis commands:',
    '/ask <question> - Ask about indexed documents',
    '/status - Bot info',
    '/search <query> - Search indexed documents',
    '/docs - Show indexing stats',
    '/memory - Show conversation memory',
    '/remember <note> - Save a note to memory',
    '/forget - Clear conversation memory',
    '/skills - List available skills',
    '/unpair - Remove pairing',
    '/help - This message',
    '',
    'Plain text messages are treated as questions.'
  ];
  if (isOwner(msg.senderId, config, msg)) {
    cmds.splice(1, 0,
      '/exec <cmd> - Run a shell command (owner)',
      '/read <path> - Read a file or directory (owner)',
      '/index <path> <public|admin> - Index a document (owner)',
      '/pin - Change PIN (owner)',
      '/mode - List chat modes / /mode <off|business|silent> [target] (owner)',
      '/agent [name] - Show/set agent for this chat (owner)',
      '/agents - List all agents (owner)',
      'Send a file to index it (owner, Telegram only)',
      'Use @agentname to invoke a specific agent per-message'
    );
  }
  await platform.send(msg.chatId, cmds.join('\n'));
}

async function handleDocumentUpload(msg, platform, config, indexer) {
  if (!isPaired(msg, config)) return;
  if (!isOwner(msg.senderId, config, msg)) {
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
      const id = String(userId);
      addAllowedUser(id);
      if (!config.allowed_users.map(String).includes(id)) {
        config.allowed_users.push(id);
      }
      if (!config.owner_id) config.owner_id = id;
      const role = String(config.owner_id) === id ? 'owner' : 'user';
      ctx.reply(`Paired successfully as ${role}! Welcome, ${username}.`);
      logAudit({ action: 'pair', user_id: id, username, status: 'success' });
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
        '/mode <off|business|silent> - Set chat mode (owner)',
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
      return `${i + 1}. [${r.element}] ${p}\n${preview}...`;
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
  buildAgentRegistry,
  resolveAgent,
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
