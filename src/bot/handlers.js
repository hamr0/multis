const path = require('path');
const { logAudit } = require('../governance/audit');
const { addAllowedUser, isOwner, isAdmin, addAdmin, removeAdmin, saveConfig, backupConfig, updateChatMeta, getMultisDir, PATHS } = require('../config');
const { execCommand, readFile, listSkills } = require('../skills/executor');
const { DocumentIndexer } = require('../indexer/index');
const { createProvider, simpleGenerate } = require('../llm/provider-adapter');
const { buildRAGPrompt, buildMemorySystemPrompt, buildBusinessPrompt } = require('../llm/prompts');
const { getMemoryManager } = require('../memory/manager');
const { runCapture, runCondenseMemory } = require('../memory/capture');
const { PinManager, hashPin } = require('../security/pin');
const { RateLimiter } = require('../security/rate-limit');
const { detectInjection, logInjectionAttempt } = require('../security/injection');
const { buildToolRegistry, getToolsForUser, loadToolsConfig } = require('../tools/registry');
const { adaptTools } = require('../tools/adapter');
const { getPlatform } = require('../tools/platform');
const { Loop, Retry, CircuitBreaker } = require('bare-agent');
const { getScheduler, parseRemind, parseCron, formatJob } = require('./scheduler');
const { createGate } = require('../governance/gate');
const { createHumanPrompt, createPinChallenge, createConfirmChallenge } = require('../governance/human-channel');
const { PendingRegistry } = require('./pending');

// Picker / wizard lifetimes, single-sourced from config (see config.js
// `interaction` block). Quick numeric pickers expire fast; the multi-step
// business wizard gets a longer window so a slow fill isn't dropped mid-flow.
const pickerTtlMs = (config) => (config.interaction?.picker_ttl_minutes ?? 5) * 60_000;
const wizardTtlMs = (config) => (config.interaction?.wizard_ttl_minutes ?? 30) * 60_000;
const PKG_VERSION = require('../../package.json').version;
const { looksLikeCommand } = require('../platforms/message');
const { mark, startClock } = require('../debug/instr'); // TEMP: timeout instrumentation

// ---------------------------------------------------------------------------
// Admin presence pause — when owner messages in a business chat, bot pauses
// ---------------------------------------------------------------------------
const _adminPaused = new Map(); // chatId → resumeAt timestamp

function setAdminPause(chatId, minutes) {
  _adminPaused.set(chatId, Date.now() + minutes * 60 * 1000);
}

function isAdminPaused(chatId) {
  const resumeAt = _adminPaused.get(chatId);
  if (!resumeAt) return false;
  if (Date.now() >= resumeAt) {
    _adminPaused.delete(chatId);
    return false;
  }
  return true;
}

function clearAdminPauses() {
  _adminPaused.clear();
}

/**
 * Notify the owner/admin channels. Mirrors the escalate tool's routing so
 * non-LLM events (e.g. a rate-limit trip) can reach a human. Best-effort.
 */
async function notifyAdmins(platformRegistry, config, text) {
  let sent = 0;
  const override = config?.business?.escalation?.admin_chat;
  if (override) {
    for (const [, plat] of platformRegistry || []) {
      if (plat?.send) { try { await plat.send(override, text); sent++; break; } catch { /* try next */ } }
    }
    return sent;
  }
  for (const [name, plat] of platformRegistry || []) {
    try {
      if (name === 'telegram' && config?.owner_id) {
        await plat.send(config.owner_id, text); sent++;
      } else if (name === 'beeper' && plat.getAdminChatIds) {
        for (const chatId of plat.getAdminChatIds()) { await plat.send(chatId, text); sent++; }
      }
    } catch { /* best-effort notify */ }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Governance — bareguard Gate per router instance. Shared budget + audit
// across all chats served by this router. Lazy-init: built on first agent
// loop invocation since loading the ESM `bareguard` module requires `await
// import()`.
//
// gov.resolve() returns the bundle. gov.platformRegistry is mutable so the
// humanPrompt closure can route prompts back via the registered platforms.
// ---------------------------------------------------------------------------

function createGovernanceCarrier(config, opts = {}) {
  const platformRegistry = new Map();
  let resolved = null;
  let resolving = null;

  const carrier = {
    platformRegistry,
    setPlatformRegistry(registry) {
      // copy entries from the router's registry into ours so humanPrompt can
      // dispatch to the right transport
      for (const [k, v] of registry) platformRegistry.set(k, v);
    },
    async resolve() {
      if (resolved) return resolved;
      if (resolving) return resolving;
      resolving = (async () => {
        const humanPrompt = opts.humanPrompt || createHumanPrompt({
          platformRegistry,
          pinManager: opts.pinManager,
          config,
          pending: opts.pending,
          timeoutMs: (config?.security?.checkpoint_timeout || 60) * 1000,
        });
        // Capability-layer PIN (#5): privileged tools on the agent path prompt
        // for PIN via the same reply-wait the approval flow uses.
        const pinChallenge = opts.pinChallenge || createPinChallenge({
          platformRegistry,
          pinManager: opts.pinManager,
          pending: opts.pending,
          timeoutMs: (config?.security?.pin_prompt_timeout || 300) * 1000,
        });
        // Catastrophic-command confirm tier (typed CONFIRM after the PIN).
        const confirmChallenge = opts.confirmChallenge || createConfirmChallenge({
          platformRegistry,
          pending: opts.pending,
          timeoutMs: (config?.security?.pin_prompt_timeout || 300) * 1000,
        });
        const built = await createGate({
          config,
          humanPrompt,
          pinChallenge,
          confirmChallenge,
          auditPath: opts.auditPath,
          budgetFile: opts.budgetFile,
          fileless: opts.fileless,
          governance: opts.governance,
        });
        resolved = built;
        return built;
      })();
      // Self-heal on transient init failure (e.g. bareguard ESM import error).
      // Without this, every subsequent message would receive the same rejected
      // promise and the bot would be permanently broken until restart.
      resolving.catch(() => { resolving = null; });
      return resolving;
    },
  };

  return carrier;
}

// ---------------------------------------------------------------------------
// Agent registry + resolution
// ---------------------------------------------------------------------------

/**
 * Build agent registry from config.agents.
 * Each agent: { llm, persona, model }. Reuses globalLlm when model matches.
 * Falls back to single-entry map with no persona if config.agents is missing/invalid.
 */
function buildAgentRegistry(config, globalProvider) {
  const fallback = new Map([['default', { provider: globalProvider, persona: null, model: config.llm?.model }]]);

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

    let agentProvider = globalProvider;
    if (agent.model && agent.model !== globalModel && globalProvider) {
      try {
        agentProvider = createProvider({ ...config.llm, model: agent.model });
      } catch (err) {
        console.warn(`Agent "${name}" LLM init failed (${err.message}) — using global.`);
      }
    }

    registry.set(name, { provider: agentProvider, persona: agent.persona, model: agent.model || globalModel });
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
  const indexer = deps.indexer || new DocumentIndexer(null, {
    maxSize: config.documents?.maxSize,
    maxPdfPages: config.documents?.maxPdfPages,
    parseTimeoutMs: config.documents?.parseTimeoutMs,
  });
  const memoryManagers = deps.memoryManagers || new Map();
  const _memBaseDir = deps.memoryBaseDir || PATHS.memory();
  const pinManager = deps.pinManager || new PinManager(config);
  // Single store for every "next message is special" state (PIN entry,
  // pin-change, and — as later phases migrate — gate challenges and pickers).
  // Keyed by chatId:senderId, TTL-expiring, announce-on-expiry.
  const pending = deps.pending || new PendingRegistry();
  // Business-mode inbound limiter (per-sender). Disabled only if explicitly off.
  const rlCfg = config.security?.rate_limit || {};
  const rateLimiter = deps.rateLimiter
    || (rlCfg.enabled === false ? null : new RateLimiter({
      burstPerMin: rlCfg.burst_per_min,
      dailyPerSender: rlCfg.daily_per_sender,
    }));
  // gov is a lazy carrier — gov.resolve() returns {gate, policy, onLlmResult,
  // onToolResult, filterTools, HaltError}. Lazy because bareguard is ESM and
  // requires `await import()` on first use. Tests can pass deps.gov to inject
  // a fully-built governance bundle (skips Gate construction).
  const gov = deps.gov || createGovernanceCarrier(config, {
    humanPrompt: deps.humanPrompt,
    auditPath: deps.auditPath,
    budgetFile: deps.budgetFile,
    fileless: deps.fileless,
    governance: deps.governanceFile,
    pinManager,
    pending,
  });
  // Helper: getMemoryManager with baseDir (follows getMultisDir for test isolation)
  const getMem = (chatId, opts = {}) =>
    getMemoryManager(memoryManagers, chatId, { ...opts, baseDir: _memBaseDir });

  // Memory config defaults
  const memCfg = {
    recent_window: config.memory?.recent_window || 20,
    capture_threshold: config.memory?.capture_threshold || 20,
    ...config.memory
  };

  // Create LLM provider if configured (null if no API key)
  // Accept deps.provider (new) or deps.llm (legacy test compat)
  let provider = deps.provider || deps.llm || null;
  if (!provider) {
    try {
      if (config.llm?.apiKey || config.llm?.provider === 'ollama') {
        provider = createProvider(config.llm);
      }
    } catch (err) {
      console.warn(`LLM init skipped: ${err.message}`);
    }
  }

  // Build agent registry
  const agentRegistry = deps.agentRegistry || buildAgentRegistry(config, provider);

  // Build tool registry (platform-filtered, config-filtered)
  const toolsConfig = deps.toolsConfig || loadToolsConfig();
  const allTools = deps.tools || buildToolRegistry(toolsConfig);
  const runtimePlatform = deps.runtimePlatform || getPlatform();
  const maxToolRounds = config.llm?.max_tool_rounds || 5;

  // Owner commands that require PIN auth
  const PIN_PROTECTED = new Set(['exec', 'read', 'index']);

  // Platform registry — populated via router.registerPlatform()
  const platformRegistry = new Map();

  const router = async (msg, platform) => {
    // Handle Telegram document uploads
    if (msg._document) {
      if (isOwner(msg.senderId, config, msg)) {
        await handleDocumentUpload(msg, platform, config, indexer);
      } else {
        await handleSilentAttachment(msg, platform, config, indexer, 'telegram');
      }
      return;
    }

    // Handle Beeper file attachments
    if (msg._attachments?.length > 0) {
      if (msg.routeAs === 'silent') {
        // silent mode: silently index supported docs, no reply
        await handleSilentAttachment(msg, platform, config, indexer, 'beeper');
      } else if (msg.routeAs === 'business' && !isOwner(msg.senderId, config, msg)) {
        // business mode, non-owner: silently index, no interactive prompt
        await handleSilentAttachment(msg, platform, config, indexer, 'beeper');
      } else if (isOwner(msg.senderId, config, msg)) {
        await handleBeeperFileIndex(msg, platform, config, indexer, pending);
      } else {
        await handleSilentAttachment(msg, platform, config, indexer, 'beeper');
      }
      return;
    }

    // Interactive replies (PIN, humanChannel, mode picker) must be checked before routeAs
    // so they aren't swallowed by natural/silent/business routing
    const text = msg.text || '';

    // Pending interaction — the single store for every "next message is special"
    // state for this conversation: a parked gate challenge (approval/PIN/CONFIRM),
    // a PIN command entry, the pin-change flow, … One lookup, one TTL. entry.match
    // decides whether THIS reply belongs to the prompt; a non-matching message (a
    // /command, an unrelated query) falls through to normal routing below.
    {
      const entry = pending.get(msg.chatId, msg.senderId);
      if (entry && (typeof entry.match !== 'function' || entry.match(text))) {
        if (entry.expired) {
          // Announce expiry rather than letting a late reply (PIN digits, a
          // confirm word) fall through to the RAG pipeline as a search query —
          // the orphaned-reply bug this de-tangle exists to kill.
          await platform.send(msg.chatId, entry.expireMsg
            || 'That prompt expired — please re-send the command.');
          return;
        }
        const t = text.trim();
        switch (entry.kind) {
          case 'gate_reply':
            // A parked bareguard challenge (approval/PIN/CONFIRM) is awaiting this
            // reply. Hand it the RAW text — the challenge interprets yes/no/PIN/
            // CONFIRM itself — and it self-clears via the resolver.
            entry.resolve(text);
            return;
          case 'pin_change':
            await handlePinChangeStep(msg, platform, config, pinManager, pending, t, entry);
            return;
          case 'pin_command': {
            const result = pinManager.authenticate(msg.senderId, t);
            if (!result.success) {
              // Wrong PIN keeps the pending command so the owner can retry;
              // only a lockout clears it.
              if (result.locked) pending.clear(msg.chatId, msg.senderId);
              await platform.send(msg.chatId, result.reason);
              return;
            }
            // PIN correct — claim the entry SYNCHRONOUSLY, before the first await,
            // so a concurrent duplicate reply finds nothing and can't double-run
            // the stored command (the get→clear window otherwise spans the
            // platform.send below). authenticate() above is synchronous.
            const stored = entry.data; // { command, args, msg, platform }
            pending.clear(msg.chatId, msg.senderId);
            await platform.send(msg.chatId, 'PIN accepted.');
            await executeCommand(stored.command, stored.args, stored.msg, platform, config, indexer, provider, memoryManagers, memCfg, pinManager, agentRegistry, { allTools, toolsConfig, runtimePlatform, maxToolRounds, gov, pending });
            return;
          }

          // --- Interactive pickers / wizards (migrated from config._pending*) ---
          // None carry a `match` fn, so they always enter here. Each owns its
          // cancel/fall-through contract: a case that `return`s consumes the
          // reply; a case that `break`s lets the message fall through to normal
          // command routing below (used for the /command-cancels-a-picker path).
          // Only one entry exists per (chat,sender), so the latest prompt is
          // authoritative — this also kills the old hazard where a numeric reply
          // meant for the mode picker was swallowed by a still-open index prompt.

          case 'admin':
            if (t.startsWith('/')) {
              pending.clear(msg.chatId, msg.senderId);
              await platform.send(msg.chatId, 'Admin setup cancelled.');
              break; // /command cancels the picker, then routes normally
            }
            await handleAdminFlowReply(msg, platform, config, t, pinManager, entry.data, pending);
            return;

          case 'index': {
            if (/^[123]$/.test(t)) {
              const idx = entry.data; // { fileName, srcURL }
              pending.clear(msg.chatId, msg.senderId);
              if (t === '3') {
                await platform.send(msg.chatId, 'Skipped.');
                return;
              }
              const scope = t === '1' ? 'public' : 'admin';
              try {
                await platform.send(msg.chatId, `Downloading and indexing: ${idx.fileName} (${scope})...`);
                const buffer = await platform.downloadAsset(idx.srcURL);
                const count = await indexer.indexBuffer(buffer, idx.fileName, scope);
                await platform.send(msg.chatId, `Indexed ${count} chunks from ${idx.fileName} [${scope}]`);
                logAudit({ action: 'index_upload', user_id: msg.senderId, filename: idx.fileName, chunks: count, scope, platform: 'beeper' });
              } catch (err) {
                await platform.send(msg.chatId, `Index error: ${err.message}`);
              }
              return;
            }
            // Any non-[123] reply drops the stale prompt and falls through
            // (mirrors the old clear-on-other-input behavior — no message).
            pending.clear(msg.chatId, msg.senderId);
            break;
          }

          case 'mode': {
            if (text.startsWith('/')) {
              pending.clear(msg.chatId, msg.senderId);
              await platform.send(msg.chatId, 'Mode selection cancelled.');
              break; // /command cancels the picker, then routes normally
            }
            const m = entry.data; // { mode, matches, agent }
            if (/^\d+$/.test(t)) {
              const idx = parseInt(t, 10) - 1;
              if (idx >= 0 && idx < m.matches.length) {
                const chat = m.matches[idx];
                // Block silent/off for personal/note-to-self chats
                const beeperPlat = platformRegistry?.get('beeper');
                if ((m.mode === 'silent' || m.mode === 'off') && beeperPlat?._personalChats?.has(chat.id)) {
                  pending.clear(msg.chatId, msg.senderId);
                  await platform.send(msg.chatId, 'Personal/note-to-self chats cannot be set to silent or off.');
                  return;
                }
                setChatMode(config, chat.id, m.mode);
                if (m.agent) {
                  if (!config.chat_agents) config.chat_agents = {};
                  config.chat_agents[chat.id] = m.agent;
                  saveConfig(config);
                }
                pending.clear(msg.chatId, msg.senderId);
                const agentNote = m.agent ? `, agent: ${m.agent}` : '';
                await platform.send(msg.chatId, `${chat.title || chat.id} set to: ${m.mode}${agentNote}`);
                logAudit({ action: 'mode', user_id: msg.senderId, chatId: chat.id, mode: m.mode, agent: m.agent });
              } else {
                await platform.send(msg.chatId, `Invalid choice. Pick 1-${m.matches.length}.`);
              }
              return;
            }
            // Non-number, non-command reply: remind, keep the picker open.
            await platform.send(msg.chatId, `Pick a number (1-${m.matches.length}) or send a /command to cancel.`);
            return;
          }

          case 'business_menu': {
            if (text.startsWith('/')) {
              pending.clear(msg.chatId, msg.senderId);
              await platform.send(msg.chatId, 'Business menu cancelled.');
              break; // /command cancels the picker, then routes normally
            }
            const handled = await handleBusinessMenuReply(msg, platform, config, t, agentRegistry, platformRegistry, entry.data, pending);
            if (handled) return;
            break;
          }

          case 'business_wizard':
            if (text.startsWith('/')) {
              pending.clear(msg.chatId, msg.senderId);
              await platform.send(msg.chatId, 'Business setup cancelled.');
              break; // /command cancels the wizard, then routes normally
            }
            await handleBusinessWizardStep(msg, platform, config, t, entry.data, pending);
            return;
        }
      }
    }

    // Off mode: defense-in-depth — no logging, no processing
    if (msg.routeAs === 'off') return;

    // Silent mode: archive to memory, trigger capture pipeline, no response
    if (msg.routeAs === 'silent') {
      const admin = isOwner(msg.senderId, config, msg);
      const mem = getMem(msg.chatId, { isAdmin: admin });
      if (mem) {
        const role = msg.isSelf ? 'user' : 'contact';
        mem.appendMessage(role, msg.text);
        mem.appendToLog(role, msg.text);

        // Persist chat metadata to config.chats
        if (msg.chatName || msg.network) {
          const fields = { platform: msg.platform };
          if (msg.chatName) fields.name = msg.chatName;
          if (msg.network) fields.network = msg.network;
          updateChatMeta(config, msg.chatId, fields);
        }

        // Fire two-stage capture when threshold reached
        if (mem.shouldCapture(memCfg.capture_threshold)) {
          const captureRole = admin ? 'admin' : `user:${msg.chatId}`;
          runCapture(msg.chatId, mem, simpleGenerate(provider), indexer, {
            keepLast: 5,
            role: captureRole,
            maxSections: memCfg.memory_max_sections
          }).then(() => {
            // Stage 2: condense if memory.md sections >= cap
            const sectionCap = memCfg.memory_section_cap || 5;
            if (mem.countMemorySections() >= sectionCap) {
              return runCondenseMemory(msg.chatId, mem, simpleGenerate(provider), indexer, {
                sectionCap, keepRecent: 3, role: captureRole
              });
            }
          }).catch(err => {
            console.error(`[capture] Silent background error: ${err.message}`);
          });
        }
      }
      return;
    }

    // Natural language / business routing (set by platform adapter)
    if (msg.routeAs === 'natural' || msg.routeAs === 'business') {
      // Business: anyone can get a response (customers via Beeper). Natural:
      // paired users or designated limited-admin chats.
      if (msg.routeAs !== 'business' && !isPaired(msg, config) && !isAdmin(msg.senderId, config, msg)) return;

      // Silently ignore empty / media-only messages in business chats
      if (msg.routeAs === 'business') {
        const trimmed = (msg.text || '').trim();
        if (!trimmed) return;
      }

      // Admin presence pause for business chats
      if (msg.routeAs === 'business') {
        const admin = isOwner(msg.senderId, config, msg);
        if (admin) {
          // Owner typing in business chat → pause bot, archive message
          const pauseMin = config.business?.escalation?.admin_pause_minutes ?? 30;
          setAdminPause(msg.chatId, pauseMin);
          const mem = getMem(msg.chatId, { isAdmin: true });
          if (mem) { mem.appendMessage('user', msg.text); mem.appendToLog('user', msg.text); }
          return;
        }
        if (isAdminPaused(msg.chatId)) {
          // Customer messages while admin is active → silently archive, no LLM
          const mem = getMem(msg.chatId, { isAdmin: false });
          if (mem) { mem.appendMessage('user', msg.text); mem.appendToLog('user', msg.text); }
          return;
        }

        // Per-customer rate limit. On the cap we archive the message, hand off
        // to a human, and stop the LLM — degrade, don't refuse (#1).
        if (rateLimiter) {
          const verdict = rateLimiter.consume(msg.senderId);
          if (!verdict.allowed) {
            const mem = getMem(msg.chatId, { isAdmin: false });
            if (mem) { mem.appendMessage('user', msg.text); mem.appendToLog('user', msg.text); }
            if (verdict.notify) {
              const note = config.business?.rate_limit_message
                || "Thanks for your patience — I've reached my limit here for now and have flagged a human to follow up with you.";
              await platform.send(msg.chatId, note);
              const who = config.chats?.[msg.chatId]?.name || msg.chatId;
              await notifyAdmins(platformRegistry, config,
                `[Rate limit] ${who} hit the ${verdict.scope} limit — bot paused for this customer; please follow up.`);
              logAudit({ action: 'rate_limit', user_id: msg.senderId, chatId: msg.chatId, scope: verdict.scope });
            }
            return;
          }
        }
      }

      await routeAsk(msg, platform, config, indexer, provider, msg.text, getMem, memCfg, agentRegistry, { allTools, toolsConfig, runtimePlatform, maxToolRounds, platformRegistry, gov });
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

    // Auth check for all other commands. Designated limited-admin chats may
    // issue commands even though they aren't in allowed_users.
    if (!isPaired(msg, config) && !isAdmin(msg.senderId, config, msg)) {
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
        pending.set(msg.chatId, msg.senderId, 'pin_command', {
          data: { command, args, msg, platform },
          match: (t) => /^\d{4,6}$/.test(t.trim()),
          expireMsg: 'PIN entry expired — please re-send the command.',
        });
        await platform.send(msg.chatId, 'Enter your PIN:');
        return;
      }
    }

    await executeCommand(command, args, msg, platform, config, indexer, provider, getMem, memCfg, pinManager, agentRegistry, { allTools, toolsConfig, runtimePlatform, maxToolRounds, platformRegistry, gov, pending });
  };

  router.registerPlatform = (name, instance) => {
    platformRegistry.set(name, instance);
    gov.platformRegistry.set(name, instance);
  };

  // Initialize scheduler with centralized tick handler (call after platforms registered)
  router.initScheduler = () => {
    const tick = createSchedulerTick({
      platformRegistry, config, provider, indexer, getMem, memCfg,
      allTools, toolsConfig, runtimePlatform, maxToolRounds, gov
    });
    const scheduler = getScheduler(tick);
    return scheduler;
  };

  return router;
}

async function executeCommand(command, args, msg, platform, config, indexer, provider, getMem, memCfg, pinManager, agentRegistry, toolDeps) {
    switch (command) {
      case 'status':
        await routeStatus(msg, platform, config);
        break;
      case 'unpair':
        await routeUnpair(msg, platform, config);
        break;
      case 'exec':
        await routeExec(msg, platform, config, args, toolDeps);
        break;
      case 'read':
        await routeRead(msg, platform, config, args, toolDeps);
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
        await routeAsk(msg, platform, config, indexer, provider, args, getMem, memCfg, agentRegistry, toolDeps);
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
        await routeMode(msg, platform, config, args, agentRegistry, toolDeps.platformRegistry, toolDeps.pending);
        break;
      case 'admin':
        await routeAdmin(msg, platform, config, args, toolDeps.platformRegistry, toolDeps.pending);
        break;
      case 'agent':
        await routeAgent(msg, platform, config, args, agentRegistry);
        break;
      case 'agents':
        await routeAgents(msg, platform, agentRegistry);
        break;
      case 'pin':
        await routePinChange(msg, platform, config, pinManager, toolDeps.pending);
        break;
      case 'remind':
        await routeRemind(msg, platform, config, provider, toolDeps);
        break;
      case 'cron':
        await routeCron(msg, platform, config, provider, toolDeps);
        break;
      case 'jobs':
        await routeJobs(msg, platform, config);
        break;
      case 'cancel':
        await routeCancel(msg, platform, config, args);
        break;
      case 'plan':
        await routePlan(msg, platform, config, provider, args, toolDeps);
        break;
      case 'help':
        await routeHelp(msg, platform, config);
        break;
      default:
        if (!looksLikeCommand(msg.text)) {
          // Plain text OR a pasted path (e.g. /home/user/file) — not a command.
          // Route to the agent loop as an implicit ask instead of dropping it.
          await routeAsk(msg, platform, config, indexer, provider, msg.text, getMem, memCfg, agentRegistry, toolDeps);
        } else {
          // Command-shaped but unrecognized — reply, never silently no-op (#4).
          await platform.send(msg.chatId, `Unknown command: /${command} — try /help`);
        }
        break;
    }
}

// pin_change entries match digit replies and share the registry's announce-on-
// expiry. The step ('verify' → 'new') lives on the entry itself.
function setPinChangePending(pending, msg, step) {
  pending.set(msg.chatId, msg.senderId, 'pin_change', {
    step,
    match: (t) => /^\d{4,6}$/.test(t.trim()),
    expireMsg: 'PIN change timed out — send /pin to start over.',
  });
}

async function routePinChange(msg, platform, config, pinManager, pending) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  if (!pinManager.isEnabled()) {
    // No PIN set — go straight to setting new PIN
    setPinChangePending(pending, msg, 'new');
    await platform.send(msg.chatId, 'No PIN set. Enter a new PIN (4-6 digits):');
    return;
  }

  // PIN is set — verify current first
  setPinChangePending(pending, msg, 'verify');
  await platform.send(msg.chatId, 'Enter your current PIN:');
}

async function handlePinChangeStep(msg, platform, config, pinManager, pending, pin, entry) {
  if (entry.step === 'verify') {
    const result = pinManager.authenticate(msg.senderId, pin);
    if (!result.success) {
      await platform.send(msg.chatId, result.reason);
      if (result.locked) pending.clear(msg.chatId, msg.senderId);
      return;
    }
    setPinChangePending(pending, msg, 'new');
    await platform.send(msg.chatId, 'Enter your new PIN (4-6 digits):');
  } else if (entry.step === 'new') {
    if (!/^\d{4,6}$/.test(pin)) {
      await platform.send(msg.chatId, 'PIN must be 4-6 digits. Try again:');
      return;
    }
    config.security.pin_hash = hashPin(pin);
    saveConfig(config);
    pending.clear(msg.chatId, msg.senderId);
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
    `multis bot v${PKG_VERSION}`,
    `Platform: ${msg.platform}`,
    `Role: ${owner ? 'owner' : 'user'}`,
    `Paired users: ${config.allowed_users.length}`,
    `LLM provider: ${config.llm.provider}`,
    `Governance: bareguard Gate (bareguard 0.4 + bare-agent 0.10)`
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

/**
 * Run a direct (slash-command) action through the same bareguard policy the
 * agent loop uses, so /exec and /read are governed identically to LLM tool
 * calls. governance = bareguard: every privileged path goes through the gate,
 * not just the LLM tool path. Returns null when allowed, or a deny/halt
 * message to surface to the user.
 */
async function enforceGate(gov, toolName, args, msg) {
  if (!gov) return null; // no governance configured — nothing to enforce
  const ctx = {
    senderId: msg.senderId,
    chatId: msg.chatId,
    isOwner: true, // slash exec/read are owner-only (caller already checked)
    platform: msg.platform,
  };
  try {
    const { policy } = await gov.resolve();
    const verdict = await policy(toolName, args, ctx);
    if (verdict === true) return null;
    return typeof verdict === 'string' ? verdict : 'Denied by governance.';
  } catch (err) {
    // HaltError or gate failure → deny closed
    return err?.message || 'Denied by governance.';
  }
}

async function routeExec(msg, platform, config, command, toolDeps = {}) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  if (!command) {
    await platform.send(msg.chatId, 'Usage: /exec <command>');
    return;
  }

  const deny = await enforceGate(toolDeps.gov, 'exec', { command }, msg);
  if (deny) {
    await platform.send(msg.chatId, deny);
    return;
  }

  const result = await execCommand(command, msg.senderId);
  await platform.send(msg.chatId, result.output);
}

async function routeRead(msg, platform, config, filePath, toolDeps = {}) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  if (!filePath) {
    await platform.send(msg.chatId, 'Usage: /read <path>');
    return;
  }

  const deny = await enforceGate(toolDeps.gov, 'read_file', { path: filePath }, msg);
  if (deny) {
    await platform.send(msg.chatId, deny);
    return;
  }

  const result = readFile(filePath, msg.senderId);
  await platform.send(msg.chatId, result.output);
}

async function routeIndex(msg, platform, config, indexer, args) {
  // Limited admins manage the knowledge base too (mode/index/ask), so allow any
  // admin window — not just the super-admin. Shell (/exec,/read) stays owner-only.
  if (!isAdmin(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Admin only command.');
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

  // The `admin` scope is the owner's trusted RAG context (owner queries retrieve
  // public+admin and inject it into the tool-enabled agent loop). A limited admin
  // manages only the public KB — letting one write `admin` would plant trusted
  // content into the owner's privileged context. Restrict admin scope to owner.
  if (role === 'admin' && !isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Only the owner can index to the admin scope. Use: /index <path> public');
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
  // Owner /search is scoped to public + admin; customer (user:*) scopes are not
  // pulled by default (#6 — cross-customer data is an opt-in, not the default).
  const roles = admin ? ['public', 'admin'] : ['public', `user:${msg.chatId}`];
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

// Shared circuit breaker (one per process, resets on provider recovery)
let _circuitBreaker = null;
function getCircuitBreaker(config) {
  if (!_circuitBreaker) {
    const cb = config?.llm?.circuit_breaker || {};
    _circuitBreaker = new CircuitBreaker({
      threshold: cb.threshold || 5,
      resetAfter: cb.resetAfter || 30000,
    });
  }
  return _circuitBreaker;
}

/**
 * Agent loop — uses bareagent Loop to call LLM with tools.
 * Includes retry (429/5xx) and circuit breaker for resilience.
 * @returns {Promise<string>} — final text answer
 */
async function runAgentLoop(agentProvider, messages, tools, opts = {}) {
  // maxRounds removed in bare-agent 0.10 — round caps live in the bareguard
  // Gate as limits.maxToolRounds, derived from config.llm.max_tool_rounds.
  // Don't accept maxRounds here so callers don't think it has any effect.
  const { system, ctx, config, gov } = opts;
  const adapted = adaptTools(tools, ctx);

  // Resolve governance lazily on first call (ESM bareguard requires await import)
  const _gc = startClock();
  const { policy, onLlmResult, onToolResult } = gov ? await gov.resolve() : {};
  mark('runAgentLoop: gov.resolve done', _gc);

  // Build retry + circuit breaker from config
  const retryCfg = config?.llm?.retry || {};
  const retry = new Retry({
    maxAttempts: retryCfg.maxAttempts || 3,
    timeout: retryCfg.timeout || 30000,
  });
  const cb = getCircuitBreaker(config);
  const wrappedProvider = cb.wrapProvider(agentProvider, config?.llm?.provider || 'default');

  // "Always ask" confirms (e.g. before every exec) are governed by bareguard's
  // flags primitive inside `policy`, routed through the single humanChannel —
  // no separate Checkpoint. governance = bareguard, one path.
  const loop = new Loop({
    provider: wrappedProvider,
    system,
    retry,
    policy,
    onLlmResult,
    onToolResult,
    throwOnError: false,
    onError: (err, meta) => {
      logAudit({ action: 'loop_error', source: meta?.source, error: err?.message, chatId: ctx.chatId, user_id: ctx.senderId });
    },
  });

  // Pass _ctx through so humanChannel can route prompts back via platformRegistry.
  const _rc = startClock();
  mark('runAgentLoop: loop.run start');
  const result = await loop.run(messages, adapted, {
    ctx: {
      senderId: ctx.senderId,
      chatId: ctx.chatId,
      isOwner: ctx.isOwner,
      platform: ctx.platform?.name || ctx.platform?.platform || ctx.platformName,
    },
  });
  mark(`runAgentLoop: loop.run done (rounds=${result.toolRounds ?? '?'}, err=${result.error ? 'yes' : 'no'})`, _rc);
  if (result.error) {
    // Halt errors come back as `error: 'halt:<rule>'` strings — surface as a normal Error
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.text || '(no response)';
}

async function routeAsk(msg, platform, config, indexer, provider, question, getMem, memCfg, agentRegistry, toolDeps = {}) {
  if (!question) {
    if (msg.routeAs !== 'business') {
      await platform.send(msg.chatId, 'Usage: /ask <question>');
    }
    return;
  }

  if (!provider) {
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
    // Record user message + persist chat metadata
    if (mem) {
      mem.appendMessage('user', question);
      mem.appendToLog('user', question);
      if (msg.chatName || msg.network) {
        const fields = { platform: msg.platform };
        if (msg.chatName) fields.name = msg.chatName;
        if (msg.network) fields.network = msg.network;
        updateChatMeta(config, msg.chatId, fields);
      }
    }

    // Search for relevant documents (scoped). The owner is scoped to public +
    // admin — NOT customer (user:*) scopes — so customer-planted content can't
    // surface in the owner's tool-enabled agent loop as trusted instructions (#6).
    const roles = admin ? ['public', 'admin'] : ['public', `user:${msg.chatId}`];
    const _sc = startClock();
    mark('routeAsk -> indexer.search');
    const chunks = indexer.search(question, 5, { roles });
    mark(`routeAsk <- indexer.search (${chunks.length} chunks)`, _sc);

    // Resolve agent for @mention stripping + per-chat provider only. The persona
    // layer is DEFERRED (obedient-bot-first; constitution/persona returns with the
    // memory module — see dispatch-rewrite-decision). A configured persona must
    // NOT replace the obedient base prompt, or the model loses "use your tools"
    // and deflects. So owner/natural chats run the base prompt with NO persona.
    const resolved = agentRegistry && agentRegistry.size > 0
      ? resolveAgent(question, msg.chatId, config, agentRegistry)
      : { agent: { provider }, name: 'default', text: question };
    const agentProvider = resolved.agent.provider || resolved.agent.llm || provider;

    // Only business mode injects a customer-facing persona (no host tools there).
    // Everything else (owner, natural) → base prompt, persona ignored.
    let agentPersona = null;
    if (msg.routeAs === 'business' && !admin && config.business?.name) {
      agentPersona = buildBusinessPrompt(config);
    }
    const cleanQuestion = resolved.text;

    // Build messages array from recent conversation
    const recent = mem ? mem.loadRecent() : [];
    const memoryMd = mem ? mem.loadMemory() : '';
    const system = buildMemorySystemPrompt(memoryMd, chunks, agentPersona);

    // Build messages array: recent history (excluding the just-appended user msg if already there)
    // Recent already includes the current user message from appendMessage above
    const messages = recent.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    // If @mention stripped the question, update the last message in recent
    if (cleanQuestion !== question && messages.length > 0) {
      messages[messages.length - 1] = { role: 'user', content: cleanQuestion };
    }

    // If no recent history (no memory manager), fall back to single-message
    if (messages.length === 0) {
      messages.push({ role: 'user', content: cleanQuestion });
    }

    // --- Agent loop with tool calling ---
    const { allTools = [], toolsConfig: tCfg, runtimePlatform, maxToolRounds = 5, platformRegistry, gov } = toolDeps;
    const userTools = getToolsForUser(allTools, admin, tCfg);
    const ctx = { senderId: msg.senderId, chatId: msg.chatId, isOwner: admin, runtimePlatform, indexer, memoryManager: mem, platform, platformName: msg.platform, config, platformRegistry };

    const _lc = startClock();
    mark(`routeAsk -> agent loop (${userTools.length} tools, model ${config?.llm?.model || '?'})`);
    const answer = await runAgentLoop(agentProvider, messages, userTools, {
      system,
      ctx,
      config,
      gov,
    });
    mark('routeAsk <- agent loop', _lc);

    // Prefix with agent name only when multiple agents exist
    const prefixed = agentRegistry && agentRegistry.size > 1
      ? `[${resolved.name}] ${answer}`
      : answer;

    const _pc = startClock();
    mark('routeAsk -> platform.send');
    await platform.send(msg.chatId, prefixed);
    mark('routeAsk <- platform.send', _pc);

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

    // Fire-and-forget two-stage capture if threshold reached
    if (mem && memCfg && mem.shouldCapture(memCfg.capture_threshold)) {
      const captureRole = admin ? 'admin' : `user:${msg.chatId}`;
      runCapture(msg.chatId, mem, simpleGenerate(provider), indexer, {
        keepLast: 5,
        role: captureRole,
        maxSections: memCfg.memory_max_sections
      }).then(() => {
        // Stage 2: condense if memory.md sections >= cap
        const sectionCap = memCfg.memory_section_cap || 5;
        if (mem.countMemorySections() >= sectionCap) {
          return runCondenseMemory(msg.chatId, mem, simpleGenerate(provider), indexer, {
            sectionCap, keepRecent: 3, role: captureRole
          });
        }
      }).catch(err => {
        console.error(`[capture] Background error: ${err.message}`);
      });
    }
  } catch (err) {
    await platform.send(msg.chatId, `LLM error: ${err.message || err}`);
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

async function routeMode(msg, platform, config, args, agentRegistry, platformRegistry, pending) {
  // Admin command (super-admin or a designated limited admin).
  if (!isAdmin(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Admin only command.');
    return;
  }

  const parts = (args || '').trim().split(/\s+/);
  const mode = parts[0] ? parts[0].toLowerCase() : '';

  // Telegram: /mode works as admin — can set per-chat Beeper modes via platform registry
  if (msg.platform === 'telegram') {
    const beeperPlatform = platformRegistry?.get('beeper');
    const hasBeeperChats = beeperPlatform && config.platforms?.beeper?.enabled;

    if (!mode) {
      const current = config.bot_mode || 'personal';
      let statusMsg = `Bot mode: ${current}`;
      if (hasBeeperChats) {
        const allChats = listBeeperChats(beeperPlatform, config);
        if (allChats && allChats.length > 0) {
          const lines = allChats.map((c, i) => {
            const m = getChatMode(config, c.id);
            return `  ${i + 1}) ${c.title || c.id} [${m}]`;
          });
          statusMsg += `\n\nChat modes:\n${lines.join('\n')}`;
        }
      }
      statusMsg += '\n\nUsage: /mode <business|silent|off> [chat name]';
      await platform.send(msg.chatId, statusMsg);
      return;
    }

    if (!VALID_MODES.includes(mode)) {
      await platform.send(msg.chatId,
        'Usage: /mode <business|silent|off> [chat name]\n\n' +
        'Modes:\n' +
        '  business — auto-respond\n' +
        '  silent   — archive only\n' +
        '  off      — completely ignored\n\n' +
        'Without target: sets global bot mode.\n' +
        'With target: sets mode for a specific Beeper chat.'
      );
      return;
    }

    // With target → set per-chat Beeper mode
    const target = parts.slice(1).join(' ');
    if (target && hasBeeperChats) {
      const match = await findBeeperChat(beeperPlatform, target, config);
      if (!match) {
        await platform.send(msg.chatId, `No chat found matching "${target}".`);
        return;
      }
      if (match.length > 1) {
        const list = match.map((c, i) => `  ${i + 1}) ${c.title || c.name || c.id}`).join('\n');
        pending.set(msg.chatId, msg.senderId, 'mode', {
          data: { mode, matches: match, agent: null },
          ttlMs: pickerTtlMs(config),
          expireMsg: 'Mode selection expired — re-run /mode.',
        });
        await platform.send(msg.chatId, `Multiple matches:\n${list}\n\nReply with a number:`);
        return;
      }
      const chat = match[0];
      // Block silent/off for personal/note-to-self chats
      if ((mode === 'silent' || mode === 'off') && beeperPlatform?._personalChats?.has(chat.id)) {
        await platform.send(msg.chatId, 'Personal/note-to-self chats cannot be set to silent or off.');
        return;
      }
      setChatMode(config, chat.id, mode);
      await platform.send(msg.chatId, `${chat.title || chat.id} set to: ${mode}`);
      logAudit({ action: 'mode', user_id: msg.senderId, chatId: chat.id, mode, target });
      return;
    }

    // No target + business → show business menu
    if (mode === 'business') {
      await showBusinessMenu(msg, platform, config, pending);
      return;
    }

    // No target → set global bot_mode
    config.bot_mode = mode;
    saveConfig(config);
    await platform.send(msg.chatId, `Bot mode set to: ${mode}`);
    logAudit({ action: 'mode', user_id: msg.senderId, mode, scope: 'global' });
    return;
  }

  // Beeper: no args → list chats with current modes (read-only, no PIN needed)
  if (!mode) {
    if (config?.chats || typeof platform?.listInbox === 'function') {
      const allChats = listBeeperChats(platform, config);
      if (!allChats || allChats.length === 0) {
        await platform.send(msg.chatId, 'No chats found.');
        return;
      }
      const lines = allChats.map((c, i) => {
        const m = getChatMode(config, c.id);
        return `  ${i + 1}) ${c.title || c.id} [${m}]`;
      });
      await platform.send(msg.chatId, `Chat modes:\n${lines.join('\n')}`);
    } else {
      await platform.send(msg.chatId,
        'Usage: /mode <business|silent|off> [target]\n\n' +
        'Sets mode for a Beeper chat.'
      );
    }
    return;
  }

  if (!VALID_MODES.includes(mode)) {
    await platform.send(msg.chatId,
      'Usage: /mode <business|silent|off> [target]\n\n' +
      'Modes:\n' +
      '  business — auto-respond, customer-safe\n' +
      '  silent   — archive only, no bot output\n' +
      '  off      — completely ignored (no archive, no response)\n\n' +
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

  // Beeper: if target specified, search for chat by name/number
  if (target) {
    const match = await findBeeperChat(platform, target, config);
    if (!match) {
      await platform.send(msg.chatId, `No chat found matching "${target}".`);
      return;
    }
    if (match.length > 1) {
      const list = match.map((c, i) => `  ${i + 1}) ${c.title || c.name || c.id}`).join('\n');
      // Store pending mode selection (include agent for deferred assignment)
      pending.set(msg.chatId, msg.senderId, 'mode', {
        data: { mode, matches: match, agent: agentArg },
        ttlMs: pickerTtlMs(config),
        expireMsg: 'Mode selection expired — re-run /mode.',
      });
      await platform.send(msg.chatId, `Multiple matches:\n${list}\n\nReply with a number:`);
      return;
    }
    const chat = match[0];
    // Block silent/off for personal/note-to-self chats
    if ((mode === 'silent' || mode === 'off') && platform._personalChats?.has(chat.id)) {
      await platform.send(msg.chatId, 'Personal/note-to-self chats cannot be set to silent or off.');
      return;
    }
    setChatMode(config, chat.id, mode);
    assignAgent(chat.id);
    const agentNote = agentArg ? `, agent: ${agentArg}` : '';
    await platform.send(msg.chatId, `${chat.title || chat.id} set to: ${mode}${agentNote}`);
    logAudit({ action: 'mode', user_id: msg.senderId, chatId: chat.id, mode, target, agent: agentArg });
    return;
  }

  // Beeper: no target + business → show business menu
  if (mode === 'business' && msg.isSelf) {
    await showBusinessMenu(msg, platform, config);
    return;
  }

  // Beeper: no target — if in self-chat, show interactive picker
  if (msg.isSelf) {
    const allChats = listBeeperChats(platform, config);
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
    pending.set(msg.chatId, msg.senderId, 'mode', {
      data: { mode, matches: chats, agent: agentArg },
      ttlMs: pickerTtlMs(config),
      expireMsg: 'Mode selection expired — re-run /mode.',
    });
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

/**
 * /admin — super-admin (owner) designates/revokes LIMITED admin windows.
 * Flow: /admin → numbered list of chats → pick → confirm → PIN → added.
 * Limited admins get mode/index/ask, NOT host shell (exec/read stay owner-only).
 * Subcommands: /admin list, /admin remove <number>.
 */
async function routeAdmin(msg, platform, config, args, platformRegistry, pending) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }
  const parts = (args || '').trim().split(/\s+/).filter(Boolean);
  const sub = parts[0] ? parts[0].toLowerCase() : '';
  const admins = config.admins || [];
  const nameOf = (id) => config.chats?.[id]?.name || id;

  if (sub === 'list') {
    if (admins.length === 0) { await platform.send(msg.chatId, 'No limited admins designated.'); return; }
    const lines = admins.map((id, i) => `  ${i + 1}) ${nameOf(id)}`);
    await platform.send(msg.chatId, `Limited admins:\n${lines.join('\n')}\n\nRemove with: /admin remove <number>`);
    return;
  }

  if (sub === 'remove') {
    if (admins.length === 0) { await platform.send(msg.chatId, 'No limited admins to remove.'); return; }
    const n = parseInt(parts[1], 10);
    if (!n || n < 1 || n > admins.length) {
      const lines = admins.map((id, i) => `  ${i + 1}) ${nameOf(id)}`);
      await platform.send(msg.chatId, `Usage: /admin remove <number>\n${lines.join('\n')}`);
      return;
    }
    const removedId = admins[n - 1];
    removeAdmin(config, removedId);
    await platform.send(msg.chatId, `Removed limited admin: ${nameOf(removedId)}`);
    logAudit({ action: 'admin_remove', user_id: msg.senderId, chatId: removedId });
    return;
  }

  // Default: start the designation picker over all known chats (any platform),
  // excluding the command channel and chats already designated.
  const adminSet = new Set(admins.map(String));
  const chats = Object.entries(config.chats || {})
    .filter(([id]) => id !== msg.chatId && !adminSet.has(String(id)))
    .map(([id, c]) => ({ id, title: c.name || id, lastActive: c.lastActive || '' }))
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive));

  if (chats.length === 0) {
    await platform.send(msg.chatId, 'No eligible chats to designate yet. (Chats appear here once they have been active.)');
    return;
  }
  const list = chats.map((c, i) => `  ${i + 1}) ${c.title}`).join('\n');
  pending.set(msg.chatId, msg.senderId, 'admin', {
    data: { step: 'pick', matches: chats },
    ttlMs: pickerTtlMs(config),
    expireMsg: 'Admin setup expired — re-run /admin.',
  });
  await platform.send(msg.chatId,
    `Pick a chat to make a LIMITED admin (mode/index/ask — NOT shell):\n${list}\n\n` +
    `Reply with a number. Or: /admin list, /admin remove <n>.`);
}

/** Drive the multi-step /admin designation flow (pick → confirm → PIN). */
async function handleAdminFlowReply(msg, platform, config, text, pinManager, state, registry) {
  // `state` is the registry entry's payload (mutated in place across steps);
  // `registry` clears it on completion/cancel.
  const pending = state;
  const nameOf = (c) => c.title || c.id;

  if (pending.step === 'pick') {
    if (!/^\d+$/.test(text)) {
      await platform.send(msg.chatId, `Pick a number (1-${pending.matches.length}), or send a /command to cancel.`);
      return;
    }
    const idx = parseInt(text, 10) - 1;
    if (idx < 0 || idx >= pending.matches.length) {
      await platform.send(msg.chatId, `Invalid choice. Pick 1-${pending.matches.length}.`);
      return;
    }
    pending.selected = pending.matches[idx];
    pending.step = 'confirm';
    await platform.send(msg.chatId, `Make "${nameOf(pending.selected)}" a limited admin (mode/index/ask, no shell)? Reply "yes" to confirm.`);
    return;
  }

  if (pending.step === 'confirm') {
    if (!/^y(es)?$/i.test(text)) {
      registry.clear(msg.chatId, msg.senderId);
      await platform.send(msg.chatId, 'Cancelled.');
      return;
    }
    if (!pinManager.isEnabled()) {
      // No PIN configured — promote directly (the owner already confirmed).
      addAdmin(config, pending.selected.id);
      const name = nameOf(pending.selected);
      registry.clear(msg.chatId, msg.senderId);
      await platform.send(msg.chatId, `Done. "${name}" is now a limited admin. (No PIN is set — consider /pin.)`);
      logAudit({ action: 'admin_add', user_id: msg.senderId, chatId: pending.selected.id });
      return;
    }
    pending.step = 'pin';
    await platform.send(msg.chatId, 'Enter your PIN to confirm:');
    return;
  }

  if (pending.step === 'pin') {
    if (!/^\d{4,6}$/.test(text)) {
      await platform.send(msg.chatId, 'PIN must be 4-6 digits. Try again:');
      return;
    }
    const result = pinManager.authenticate(msg.senderId, text);
    if (!result.success) {
      await platform.send(msg.chatId, result.reason);
      if (result.locked) registry.clear(msg.chatId, msg.senderId);
      return;
    }
    addAdmin(config, pending.selected.id);
    const name = nameOf(pending.selected);
    registry.clear(msg.chatId, msg.senderId);
    await platform.send(msg.chatId, `Done. "${name}" is now a limited admin.`);
    logAudit({ action: 'admin_add', user_id: msg.senderId, chatId: pending.selected.id });
  }
}

function setChatMode(config, chatId, mode) {
  if (!config.chats) config.chats = {};
  if (!config.chats[chatId]) config.chats[chatId] = {};
  config.chats[chatId].mode = mode;
  config.chats[chatId].lastActive = new Date().toISOString();
  saveConfig(config);
}

function getChatMode(config, chatId) {
  const stored = config.chats?.[chatId]?.mode;
  // Ignore stale 'personal' values (was renamed to profile, not a valid mode)
  if (stored && stored !== 'personal') return stored;
  if (config.platforms?.beeper?.default_mode) return config.platforms.beeper.default_mode;
  // Default: personal profile → silent, business profile → business
  const botMode = config.bot_mode || 'personal';
  return botMode === 'personal' ? 'silent' : 'business';
}

/**
 * List chats from config.chats (filter by platform=beeper), sorted by lastActive desc.
 * No Beeper API call needed — works even when Desktop is down.
 */
function listBeeperChats(platformOrConfig, config) {
  // Accept either (platform, config) or (config) for backward compat
  const cfg = config || platformOrConfig;
  if (!cfg?.chats) return [];
  const botChatId = (typeof platformOrConfig === 'object' && platformOrConfig._botChatId) ? platformOrConfig._botChatId : null;
  return Object.entries(cfg.chats)
    .filter(([id, c]) => c.platform === 'beeper' && id !== botChatId)
    .map(([id, c]) => ({
      id,
      title: c.name || '',
      network: c.network || '',
    }))
    .sort((a, b) => {
      const aTime = cfg.chats[a.id]?.lastActive || '';
      const bTime = cfg.chats[b.id]?.lastActive || '';
      return bTime.localeCompare(aTime);
    });
}

/**
 * Find a Beeper chat by name. Searches config.chats first.
 * Falls back to Beeper API for discovery of new/unseen chats, upserting into config.chats.
 */
async function findBeeperChat(platform, search, config) {
  const q = search.toLowerCase();

  // Search config.chats first
  if (config?.chats) {
    const matches = Object.entries(config.chats)
      .filter(([id, c]) => c.platform === 'beeper')
      .filter(([id, c]) =>
        (c.name && c.name.toLowerCase().includes(q)) ||
        id.toLowerCase().includes(q)
      )
      .map(([id, c]) => ({ id, title: c.name || '', network: c.network || '' }));
    if (matches.length > 0) return matches;
  }

  // Fall back to the beeperbox list_inbox verb (MCP, not raw :23373 — works
  // against a remote beeperbox) for undiscovered chats.
  if (typeof platform?.listInbox !== 'function') return null;
  try {
    backupConfig();
    const botChatId = platform._botChatId || null;
    const list = await platform.listInbox(100);
    const chats = list.map(c => ({
      id: c.id || c.chatID,
      title: c.title || c.name || '',
      network: c.network || '',
    })).filter(c => c.id && c.id !== botChatId);

    // Upsert discovered chats into config.chats
    if (config) {
      for (const c of chats) {
        if (!config.chats) config.chats = {};
        if (!config.chats[c.id]) {
          config.chats[c.id] = { name: c.title, network: c.network, platform: 'beeper', lastActive: new Date().toISOString() };
        }
      }
      saveConfig(config);
    }

    const matches = chats.filter(c =>
      (c.title && c.title.toLowerCase().includes(q)) ||
      (c.id && c.id.toLowerCase().includes(q))
    );
    return matches.length > 0 ? matches : null;
  } catch {
    return null;
  }
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

// ---------------------------------------------------------------------------
// Scheduler commands: /remind, /cron, /jobs, /cancel
// ---------------------------------------------------------------------------

/**
 * Factory: centralized tick handler for scheduler jobs.
 * Resolves platform from registry at fire time, not from a closure.
 * Agentic jobs run through runAgentLoop with owner's full toolset.
 */
function createSchedulerTick({ platformRegistry, config, provider, indexer, getMem, memCfg, allTools, toolsConfig, runtimePlatform, maxToolRounds, gov }) {
  return async (job) => {
    const platform = platformRegistry.get(job.platformName) || platformRegistry.values().next().value;
    if (!platform) {
      console.error(`[scheduler] No platform for job ${job.id} (${job.platformName})`);
      return;
    }

    if (!job.agentic) {
      await platform.send(job.chatId, `Reminder: ${job.action}`);
      return;
    }

    // Agentic path — run full agent loop as owner
    if (!provider) {
      await platform.send(job.chatId, `Job [${job.id}] failed: LLM not configured.`);
      return;
    }

    try {
      const admin = true; // agentic jobs always run as owner
      const userTools = getToolsForUser(allTools || [], admin, toolsConfig);
      const mem = getMem ? getMem(job.chatId, { isAdmin: admin }) : null;
      const memoryMd = mem ? mem.loadMemory() : '';
      const roles = undefined; // admin sees all scopes
      const chunks = indexer ? indexer.search(job.action, 5, { roles }) : [];
      const system = buildMemorySystemPrompt(memoryMd, chunks);

      const answer = await runAgentLoop(provider, [{ role: 'user', content: job.action }], userTools, {
        system,
        ctx: { senderId: config.owner_id, chatId: job.chatId, isOwner: admin, runtimePlatform, indexer, memoryManager: mem, platform, platformName: job.platformName, config, platformRegistry },
        config,
        gov,
      });
      await platform.send(job.chatId, answer);
      logAudit({ action: 'agentic_tick', jobId: job.id, jobAction: job.action });
    } catch (err) {
      await platform.send(job.chatId, `Job [${job.id}] failed: ${err.message}`);
      console.error(`[scheduler] Agentic job ${job.id} error: ${err.message}`);
    }
  };
}

async function routeRemind(msg, platform, config, provider, toolDeps) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }
  const parsed = parseRemind(msg.parseCommand()?.args);
  if (!parsed) {
    await platform.send(msg.chatId, 'Usage: /remind <duration> <action>\nExample: /remind 2h check inbox\nAdd --agent for AI-powered reminders.');
    return;
  }

  const scheduler = getScheduler();
  const job = scheduler.add({
    schedule: parsed.schedule,
    action: parsed.action,
    type: 'one-shot',
    agentic: parsed.agentic || false,
    chatId: String(msg.chatId),
    platformName: msg.platform
  });
  const tag = parsed.agentic ? ' [agent]' : '';
  await platform.send(msg.chatId, `Reminder set: "${parsed.action}" in ${parsed.schedule}${tag} [${job.id}]`);
  logAudit({ action: 'remind', user_id: msg.senderId, schedule: parsed.schedule, jobAction: parsed.action, agentic: parsed.agentic });
}

async function routeCron(msg, platform, config, provider, toolDeps) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }
  const parsed = parseCron(msg.parseCommand()?.args);
  if (!parsed) {
    await platform.send(msg.chatId, 'Usage: /cron <cron-expression> <action>\nExample: /cron 0 9 * * 1-5 morning briefing\nAdd --agent for AI-powered jobs.');
    return;
  }

  const scheduler = getScheduler();
  const job = scheduler.add({
    schedule: parsed.schedule,
    action: parsed.action,
    type: 'recurring',
    agentic: parsed.agentic || false,
    chatId: String(msg.chatId),
    platformName: msg.platform
  });
  const tag = parsed.agentic ? ' [agent]' : '';
  await platform.send(msg.chatId, `Cron job added: "${parsed.action}"${tag} [${job.id}]`);
  logAudit({ action: 'cron', user_id: msg.senderId, schedule: parsed.schedule, jobAction: parsed.action, agentic: parsed.agentic });
}

async function routeJobs(msg, platform, config) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }
  const scheduler = getScheduler();
  const jobs = scheduler.list();
  if (jobs.length === 0) {
    await platform.send(msg.chatId, 'No active jobs.');
    return;
  }
  const lines = jobs.map(formatJob);
  await platform.send(msg.chatId, `Active jobs:\n${lines.join('\n')}`);
}

async function routeCancel(msg, platform, config, jobId) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }
  if (!jobId) {
    await platform.send(msg.chatId, 'Usage: /cancel <job-id>');
    return;
  }
  const scheduler = getScheduler();
  const removed = scheduler.remove(jobId.trim());
  if (removed) {
    await platform.send(msg.chatId, `Job ${jobId} cancelled.`);
    logAudit({ action: 'cancel_job', user_id: msg.senderId, jobId });
  } else {
    await platform.send(msg.chatId, `Job ${jobId} not found.`);
  }
}

// ---------------------------------------------------------------------------
// Planner command: /plan
// ---------------------------------------------------------------------------

async function routePlan(msg, platform, config, provider, goal, toolDeps) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }
  if (!goal) {
    await platform.send(msg.chatId, 'Usage: /plan <goal>\nExample: /plan organize my documents');
    return;
  }
  if (!provider) {
    await platform.send(msg.chatId, 'LLM not configured.');
    return;
  }

  try {
    const { Planner, runPlan } = require('bare-agent');
    const planner = new Planner({ provider });

    await platform.send(msg.chatId, `Planning: "${goal}"...`);
    const steps = await planner.plan(goal);

    if (!steps || steps.length === 0) {
      await platform.send(msg.chatId, 'Could not break this into steps. Try rephrasing.');
      return;
    }

    // Show the plan
    const planText = steps.map((s, i) => `${i + 1}. ${s.action}`).join('\n');
    await platform.send(msg.chatId, `Plan:\n${planText}\n\nExecuting...`);

    // Execute steps sequentially via the agent loop
    const { allTools = [], toolsConfig: tCfg, runtimePlatform, maxToolRounds = 5, platformRegistry, gov } = toolDeps;
    const admin = isOwner(msg.senderId, config, msg);
    const userTools = getToolsForUser(allTools, admin, tCfg);

    for (const step of steps) {
      try {
        const answer = await runAgentLoop(provider, [{ role: 'user', content: step.action }], userTools, {
          ctx: { senderId: msg.senderId, chatId: msg.chatId, isOwner: admin, runtimePlatform, platform, platformName: msg.platform, config, platformRegistry },
          config,
          gov,
        });
        await platform.send(msg.chatId, `Step "${step.action}": ${answer}`);
      } catch (err) {
        await platform.send(msg.chatId, `Step "${step.action}" failed: ${err.message}`);
      }
    }

    await platform.send(msg.chatId, 'Plan complete.');
    logAudit({ action: 'plan', user_id: msg.senderId, goal, steps: steps.length });
  } catch (err) {
    await platform.send(msg.chatId, `Plan error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// /mode business menu + setup wizard
// ---------------------------------------------------------------------------

async function showBusinessMenu(msg, platform, config, pending) {
  pending.set(msg.chatId, msg.senderId, 'business_menu', {
    data: { senderId: msg.senderId },
    ttlMs: pickerTtlMs(config),
    expireMsg: 'Business menu expired — re-run /mode business.',
  });
  await platform.send(msg.chatId,
    'Business Mode\n' +
    '1) Setup persona\n' +
    '2) Show persona\n' +
    '3) Clear persona\n' +
    '4) Set as global default\n' +
    '5) Assign chats\n\n' +
    'Reply with a number:'
  );
}

async function handleBusinessMenuReply(msg, platform, config, input, agentRegistry, platformRegistry, state, registry) {
  const pending = state;
  if (!pending) return false;

  const choice = parseInt(input, 10);
  if (isNaN(choice) || choice < 1 || choice > 5) {
    await platform.send(msg.chatId, 'Pick 1-5 or send a /command to cancel.');
    return true;
  }

  registry.clear(msg.chatId, msg.senderId);

  switch (choice) {
    case 1: {
      // Launch wizard — pre-populated from existing config. Replaces the menu
      // entry on the same (chat,sender) key; longer TTL for the multi-step fill.
      const existing = config.business || {};
      registry.set(msg.chatId, msg.senderId, 'business_wizard', {
        ttlMs: wizardTtlMs(config),
        expireMsg: 'Business setup expired — re-run /mode business → 1.',
        data: {
          step: 'name',
          data: {
            name: existing.name || null,
            greeting: existing.greeting || null,
            topics: existing.topics ? existing.topics.map(t => ({ ...t })) : [],
            rules: existing.rules ? [...existing.rules] : []
          }
        }
      });
      const current = existing.name ? `\nCurrent: ${existing.name}` : '';
      await platform.send(msg.chatId, `Step 1/5 — Name${current}\nSend new name or "skip" to keep it.`);
      return true;
    }
    case 2: {
      // Show persona
      const b = config.business || {};
      if (!b.name) {
        await platform.send(msg.chatId, 'No business persona configured. Use /mode business → 1 to set one up.');
        return true;
      }
      const lines = [`Name: ${b.name}`];
      if (b.greeting) lines.push(`Greeting: ${b.greeting}`);
      if (b.topics?.length > 0) {
        lines.push('Topics:');
        b.topics.forEach((t, i) => {
          const esc = t.escalate ? ' [escalate]' : '';
          lines.push(`  ${i + 1}. ${t.name}${t.description ? ' — ' + t.description : ''}${esc}`);
        });
      }
      if (b.rules?.length > 0) {
        lines.push('Rules:');
        b.rules.forEach(r => lines.push(`  - ${r}`));
      }
      await platform.send(msg.chatId, lines.join('\n'));
      return true;
    }
    case 3: {
      // Clear persona
      config.business = { ...config.business, name: null, greeting: null, topics: [], rules: [] };
      saveConfig(config);
      await platform.send(msg.chatId, 'Business persona cleared.');
      logAudit({ action: 'business_clear', user_id: msg.senderId });
      return true;
    }
    case 4: {
      // Set as global default
      config.bot_mode = 'business';
      saveConfig(config);
      await platform.send(msg.chatId, 'Bot mode set to: business');
      logAudit({ action: 'mode', user_id: msg.senderId, mode: 'business', scope: 'global' });
      return true;
    }
    case 5: {
      // Assign chats — delegate to mode picker
      const beeperPlatform = platformRegistry?.get('beeper');
      const hasBeeperChats = beeperPlatform && config.platforms?.beeper?.enabled;
      if (!hasBeeperChats) {
        await platform.send(msg.chatId, 'No Beeper chats available. Connect Beeper first.');
        return true;
      }
      const allChats = listBeeperChats(beeperPlatform, config);
      if (!allChats || allChats.length === 0) {
        await platform.send(msg.chatId, 'No chats found.');
        return true;
      }
      const chats = allChats.filter(c => c.id !== msg.chatId);
      const list = chats.map((c, i) => {
        const currentMode = getChatMode(config, c.id);
        return `  ${i + 1}) ${c.title || c.name || c.id} [${currentMode}]`;
      }).join('\n');
      registry.set(msg.chatId, msg.senderId, 'mode', {
        data: { mode: 'business', matches: chats, agent: null },
        ttlMs: pickerTtlMs(config),
        expireMsg: 'Mode selection expired — re-run /mode.',
      });
      await platform.send(msg.chatId, `Pick a chat to set to business:\n${list}\n\nReply with a number:`);
      return true;
    }
  }
  return false;
}

async function handleBusinessWizardStep(msg, platform, config, input, state, registry) {
  // `state` is the registry entry payload { step, data } (mutated in place
  // across steps); `registry` clears it on save/cancel.
  const pending = state;
  const lower = input.toLowerCase();

  if (lower === 'cancel') {
    registry.clear(msg.chatId, msg.senderId);
    await platform.send(msg.chatId, 'Business setup cancelled.');
    return;
  }

  switch (pending.step) {
    case 'name':
      if (lower === 'skip' && pending.data.name) {
        pending.step = 'greeting';
        const current = pending.data.greeting ? `\nCurrent: ${pending.data.greeting}` : '';
        await platform.send(msg.chatId, `Step 2/5 — Greeting${current}\nSend new greeting or "skip" to keep it.`);
        break;
      }
      if (lower === 'skip') {
        await platform.send(msg.chatId, 'No existing name to keep. Send a name (2-100 characters):');
        break;
      }
      if (input.length < 2 || input.length > 100) {
        await platform.send(msg.chatId, 'Name must be 2-100 characters. Try again:');
        break;
      }
      pending.data.name = input;
      pending.step = 'greeting';
      {
        const current = pending.data.greeting ? `\nCurrent: ${pending.data.greeting}` : '';
        await platform.send(msg.chatId, `Step 2/5 — Greeting${current}\nSend new greeting or "skip" to keep it.`);
      }
      break;

    case 'greeting':
      if (lower !== 'skip') {
        if (input.length > 500) {
          await platform.send(msg.chatId, 'Greeting must be under 500 characters. Try again (or "skip"):');
          break;
        }
        pending.data.greeting = input;
      }
      pending.step = 'topics';
      {
        let prompt = 'Step 3/5 — Topics';
        if (pending.data.topics?.length > 0) {
          prompt += '\nCurrent topics:';
          pending.data.topics.forEach((t, i) => {
            prompt += `\n  ${i + 1}. ${t.name}${t.description ? ': ' + t.description : ''}`;
          });
        }
        prompt += '\nAdd topics as "Topic: Description" (one per line).\nSend "done" when finished, "skip" to keep current, or "clear" to start fresh.';
        await platform.send(msg.chatId, prompt);
      }
      break;

    case 'topics':
      if (lower === 'done') {
        pending.step = 'rules';
        let prompt = 'Step 4/5 — Rules';
        if (pending.data.rules?.length > 0) {
          prompt += '\nCurrent rules:';
          pending.data.rules.forEach((r, i) => { prompt += `\n  ${i + 1}. ${r}`; });
        }
        prompt += '\nAdd rules one per message.\nSend "done" when finished, "skip" to keep current, or "clear" to start fresh.';
        await platform.send(msg.chatId, prompt);
        break;
      }
      if (lower === 'skip') {
        pending.step = 'rules';
        let prompt = 'Step 4/5 — Rules';
        if (pending.data.rules?.length > 0) {
          prompt += '\nCurrent rules:';
          pending.data.rules.forEach((r, i) => { prompt += `\n  ${i + 1}. ${r}`; });
        }
        prompt += '\nAdd rules one per message.\nSend "done" when finished, "skip" to keep current, or "clear" to start fresh.';
        await platform.send(msg.chatId, prompt);
        break;
      }
      if (lower === 'clear') {
        pending.data.topics = [];
        await platform.send(msg.chatId, 'Topics cleared. Add topics as "Topic: Description" or send "done".');
        break;
      }
      if (input.length > 200) {
        await platform.send(msg.chatId, 'Topic must be under 200 characters. Try again:');
        break;
      }
      {
        // Parse "Topic: Description" format
        const colonIdx = input.indexOf(':');
        const topic = colonIdx > 0
          ? { name: input.slice(0, colonIdx).trim(), description: input.slice(colonIdx + 1).trim() || undefined }
          : { name: input };
        pending.data.topics.push(topic);
        await platform.send(msg.chatId, `Added: ${topic.name}. Next topic? (or "done")`);
      }
      break;

    case 'rules':
      if (lower === 'done') {
        pending.step = 'confirm';
        const summary = formatBusinessSummary(pending.data);
        await platform.send(msg.chatId, `Step 5/5 — Review & Save\n${summary}\n\nSave this? (yes/no)`);
        break;
      }
      if (lower === 'skip') {
        pending.step = 'confirm';
        const summary = formatBusinessSummary(pending.data);
        await platform.send(msg.chatId, `Step 5/5 — Review & Save\n${summary}\n\nSave this? (yes/no)`);
        break;
      }
      if (lower === 'clear') {
        pending.data.rules = [];
        await platform.send(msg.chatId, 'Rules cleared. Add a rule or send "done".');
        break;
      }
      if (input.length > 200) {
        await platform.send(msg.chatId, 'Rule must be under 200 characters. Try again:');
        break;
      }
      pending.data.rules.push(input);
      await platform.send(msg.chatId, 'Added. Next rule? (or "done")');
      break;

    case 'confirm':
      if (lower === 'yes' || lower === 'y') {
        config.business = { ...config.business, ...pending.data };
        saveConfig(config);
        registry.clear(msg.chatId, msg.senderId);
        await platform.send(msg.chatId, 'Business persona saved.');
        logAudit({ action: 'business_setup', user_id: msg.senderId, name: pending.data.name });
      } else {
        registry.clear(msg.chatId, msg.senderId);
        await platform.send(msg.chatId, 'Discarded.');
      }
      break;
  }
}

function formatBusinessSummary(data) {
  const lines = [`Business persona:\n  Name: ${data.name}`];
  if (data.greeting) lines.push(`  Greeting: ${data.greeting}`);
  if (data.topics?.length > 0) {
    lines.push('  Topics:');
    data.topics.forEach(t => {
      lines.push(`    - ${t.name}${t.description ? ': ' + t.description : ''}`);
    });
  }
  if (data.rules?.length > 0) {
    lines.push('  Rules:');
    data.rules.forEach(r => lines.push(`    - ${r}`));
  }
  // Escalation notifications auto-sent to all admin channels (Telegram + Beeper Note-to-self)
  return lines.join('\n');
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
      '/index <path> <public|admin> - Index a document (admin)',
      '/pin - Change PIN (owner)',
      '/admin - Designate/list/remove limited admins (owner)',
      '/mode - List chat modes / /mode <business|silent|off> [target] (admin)',
      '/agent [name] - Show/set agent for this chat (owner)',
      '/agents - List all agents (owner)',
      '/remind <duration> <action> [--agent] - Set a reminder (owner)',
      '/cron <expression> <action> [--agent] - Recurring scheduled task (owner)',
      '/jobs - List active scheduled jobs (owner)',
      '/cancel <id> - Cancel a scheduled job (owner)',
      '/plan <goal> - Break a goal into steps and execute (owner)',
      '/mode business - Business persona menu (owner)',
      'Send a file to index it (owner, Telegram/Beeper)',
      'Use @agentname to invoke a specific agent per-message'
    );
  } else if (isAdmin(msg.senderId, config, msg)) {
    // Limited admin: staff commands, no host shell.
    cmds.splice(1, 0,
      '/index <path> <public|admin> - Index a document (admin)',
      '/mode - List chat modes / /mode <business|silent|off> [target] (admin)'
    );
  }
  await platform.send(msg.chatId, cmds.join('\n'));
}

async function handleBeeperFileIndex(msg, platform, config, indexer, pending) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only. File indexing not available.');
    return;
  }

  const supported = ['pdf', 'docx', 'md', 'txt'];
  const attachment = msg._attachments.find(a => {
    const ext = (a.fileName || '').split('.').pop().toLowerCase();
    return supported.includes(ext);
  });

  if (!attachment) {
    await platform.send(msg.chatId, `Unsupported file type.\nSupported: ${supported.join(', ')}`);
    return;
  }

  const fileName = attachment.fileName;
  const srcURL = attachment.srcURL;

  // Parse scope from text: "/index public", "/index admin", "/index kb"
  const text = (msg.text || '').trim();
  const indexMatch = text.match(/^\/index\s+(public|kb|admin)\s*$/i);
  let scope = indexMatch ? indexMatch[1].toLowerCase() : null;
  if (scope === 'kb') scope = 'public';

  if (!scope) {
    // Ask for scope
    pending.set(msg.chatId, msg.senderId, 'index', {
      data: { fileName, srcURL },
      ttlMs: pickerTtlMs(config),
      expireMsg: 'File index prompt expired — re-send the file.',
    });
    await platform.send(msg.chatId, `Got "${fileName}". Index as:\n1. Public (kb)\n2. Admin only\n3. Skip\nReply 1, 2, or 3.`);
    return;
  }

  try {
    await platform.send(msg.chatId, `Downloading and indexing: ${fileName} (${scope})...`);
    const buffer = await platform.downloadAsset(srcURL);
    const count = await indexer.indexBuffer(buffer, fileName, scope);
    await platform.send(msg.chatId, `Indexed ${count} chunks from ${fileName} [${scope}]`);
    logAudit({ action: 'index_upload', user_id: msg.senderId, filename: fileName, chunks: count, scope, platform: 'beeper' });
  } catch (err) {
    await platform.send(msg.chatId, `Index error: ${err.message}`);
  }
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

/**
 * Silently handle non-admin attachments: index supported docs, ignore the rest.
 * Never sends a reply to the user.
 */
async function handleSilentAttachment(msg, platform, config, indexer, source) {
  const supported = ['pdf', 'docx', 'md', 'txt'];

  if (source === 'telegram') {
    const doc = msg._document;
    if (!doc) return;
    const filename = doc.file_name || 'unknown';
    const ext = filename.split('.').pop().toLowerCase();
    if (!supported.includes(ext)) return;

    try {
      const scope = `user:${msg.chatId}`;
      const fileLink = await msg._telegram.getFileLink(doc.file_id);
      const response = await fetch(fileLink.href);
      const buffer = Buffer.from(await response.arrayBuffer());
      const count = await indexer.indexBuffer(buffer, filename, scope);
      logAudit({ action: 'silent_index', user_id: msg.senderId, filename, chunks: count, scope, platform: 'telegram' });
    } catch (err) {
      console.error(`Silent index error (telegram): ${err.message}`);
    }
  } else if (source === 'beeper') {
    const attachment = (msg._attachments || []).find(a => {
      const ext = (a.fileName || '').split('.').pop().toLowerCase();
      return supported.includes(ext);
    });
    if (!attachment) return;

    try {
      const scope = `user:${msg.chatId}`;
      const buffer = await platform.downloadAsset(attachment.srcURL);
      const count = await indexer.indexBuffer(buffer, attachment.fileName, scope);
      logAudit({ action: 'silent_index', user_id: msg.senderId, filename: attachment.fileName, chunks: count, scope, platform: 'beeper' });
    } catch (err) {
      console.error(`Silent index error (beeper): ${err.message}`);
    }
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
      `multis bot v${PKG_VERSION}`,
      `Role: ${owner ? 'owner' : 'user'}`,
      `Paired users: ${config.allowed_users.length}`,
      `LLM provider: ${config.llm.provider}`,
      `Governance: bareguard Gate (bareguard 0.4 + bare-agent 0.10)`
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
  return async (ctx) => {
    if (!isPaired(ctx, config)) return;
    if (!isOwner(ctx.from.id, config)) { ctx.reply('Owner only command.'); return; }
    const text = ctx.message.text || '';
    const command = text.replace(/^\/exec\s*/, '').trim();
    if (!command) { ctx.reply('Usage: /exec <command>'); return; }
    const result = await execCommand(command, ctx.from.id);
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
        '/mode <business|silent|off> - Set chat mode (owner)',
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
  createSchedulerTick,
  buildAgentRegistry,
  resolveAgent,
  clearAdminPauses,
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
