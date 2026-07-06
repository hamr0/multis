const path = require('path');
const { logAudit } = require('../governance/audit');
const { addAllowedUser, isOwner, saveConfig, backupConfig, updateChatMeta, getMultisDir, PATHS, defaultModeForRole, roleLabel, normalizeRole } = require('../config');
const { listSkills } = require('../skills/executor');
const context = require('../context');
const { createProvider } = require('../llm/provider-adapter');
const { buildRAGPrompt, buildMemorySystemPrompt, buildBusinessPrompt } = require('../llm/prompts');
const { getMemoryManager } = require('../memory/manager');
const { rememberWithSupersede } = require('../memory/supersede');
const { PinManager, hashPin } = require('../security/pin');
const { RateLimiter } = require('../security/rate-limit');
const { detectInjection, logInjectionAttempt } = require('../security/injection');
const { buildToolRegistry, getToolsForUser, loadToolsConfig } = require('../tools/registry');
const { adaptTools } = require('../tools/adapter');
const { getPlatform } = require('../tools/platform');
const { Loop, Retry, CircuitBreaker, HaltError, unitAssembler } = require('bare-agent');
const { getScheduler, parseRemind, parseCron, formatJob } = require('./scheduler');
const { createGate } = require('../governance/gate');
const { createHumanPrompt, createCeremonyPrompt, createVerifyPin } = require('../governance/human-channel');
const { PendingRegistry } = require('./pending');
const { ASK_KIND, openAsk, resumeAsk, expireAsk } = require('./ask-dispatcher');
const { runGovernedAction, RESULT } = require('../capabilities/govern');
const { buildGovernDeps } = require('../capabilities/deps');
const { getCapabilityForTool, SEVERITY } = require('../capabilities/registry');

// Picker / wizard lifetimes, single-sourced from config (see config.js
// `interaction` block). Quick numeric pickers expire fast; the multi-step
// business wizard gets a longer window so a slow fill isn't dropped mid-flow.
const pickerTtlMs = (config) => (config.interaction?.picker_ttl_minutes ?? 5) * 60_000;
const wizardTtlMs = (config) => (config.interaction?.wizard_ttl_minutes ?? 30) * 60_000;
const PKG_VERSION = require('../../package.json').version;
const { looksLikeCommand } = require('../platforms/message');

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
        // createGate no longer consumes the ceremony (the 3-tier moved to the M9
        // core). There is no CONFIRM tier — catastrophic commands are hard-walled in
        // the core, never ceremonied.
        const built = await createGate({
          config,
          humanPrompt,
          auditPath: opts.auditPath,
          budgetFile: opts.budgetFile,
          fileless: opts.fileless,
          governance: opts.governance,
        });
        // Park-and-resume ceremony (M9 fix 2026-06-22): the governed core never
        // blocks on an inline PIN await (a serial Beeper poll loop would deadlock).
        // It returns NEEDS_CEREMONY; the caller prompts via `ceremonyPrompt`, parks
        // the action, returns, and the PIN reply is verified by `verifyPin`. All share
        // one pinManager → one PendingRegistry, no second parallel PIN path.
        const ceremonyPrompt = createCeremonyPrompt({ platformRegistry, pinManager: opts.pinManager });
        const verifyPin = createVerifyPin({ pinManager: opts.pinManager });
        const pinConfigured = !!(opts.pinManager && opts.pinManager.isEnabled());
        resolved = { ...built, ceremonyPrompt, verifyPin, pinConfigured };
        return resolved;
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

// --- M4 memory ladder helpers (module-level so both the router and the top-level
// routeAsk/scheduler can use them). An exchange/observation → a litectx `episode`
// (by:'agent', tenant-fenced, expiring at the role's retention); useful episodes
// auto-promote to durable facts via the sweep. Both fire-and-forget + guarded — a
// memory write must never break the reply path. The episode IS the conversation thread:
// `meta.turns` carries the role-tagged turns so the agent's message history reconstructs
// from litectx recency (no recent.json). Daily logs are written separately (ChatMemoryManager). ---
const memScopeFor = (admin, chatId) => (admin ? 'admin' : `user:${chatId}`);
// turns: [{role:'user'|'assistant', content}]. body = the readable transcript (for recall/promotion);
// meta.turns = the structured turns (for faithful window reconstruction — litectx never parses the body).
const fmtTurns = (turns) => turns.map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.content}`).join('\n');
// Episodes carry NO per-row TTL — litectx self-prunes them on a fixed 30-day rolling window
// (expiresAt is doc-axis only, ignored for fact/episode; litectx 0.24.0 clarification). Durability is
// the promotion ladder's job: a hot episode is copied to a durable fact before that window lapses.
const rememberEpisodeFor = (indexer, _memCfg, admin, chatId, turns) =>
  indexer.rememberEpisode(memScopeFor(admin, chatId), fmtTurns(turns), { meta: { turns } })
    .catch((e) => console.error(`[memory] episode write failed: ${e.message}`));
const sweepPromotionsFor = (indexer, memCfg, admin, chatId) =>
  indexer.promotionSweep(memScopeFor(admin, chatId), { threshold: memCfg.promote_threshold })
    .catch((e) => console.error(`[memory] promotion sweep failed: ${e.message}`));

/**
 * Main message dispatcher for all platforms.
 * Takes a normalized Message and routes to the appropriate handler.
 */
function createMessageRouter(config, deps = {}) {
  // litectx wrapper (process-wide singleton, init()-ed at startup). Tests inject deps.indexer.
  const indexer = deps.indexer || context;
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
    promote_threshold: config.memory?.promote_threshold || 10,
    ...config.memory
  };

  // M4 memory ladder helpers — thin closures binding indexer+memCfg to the module-level
  // helpers (which routeAsk/the scheduler also use, being top-level functions).
  const rememberEpisode = (admin, chatId, turns) => rememberEpisodeFor(indexer, memCfg, admin, chatId, turns);
  const sweepPromotions = (admin, chatId) => sweepPromotionsFor(indexer, memCfg, admin, chatId);

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

  // Platform registry — populated via router.registerPlatform()
  const platformRegistry = new Map();

  // Senders we've already audit-logged a Telegram owner-only reject for, so a
  // non-owner spamming the bot writes ONE audit line (probing signal), not one
  // per message (which would flood the append-only audit log). Per-process; a
  // restart re-arms. Bounded in practice by distinct Telegram accounts seen.
  const loggedTelegramRejects = new Set();

  const router = async (msg, platform) => {
    // Telegram is owner-only (personal-bot role). Reject every non-owner message —
    // even a paired one, even /start, even a file upload — before any routing, so
    // admin-scoped content, the owner's tool-oriented base prompt, and customer
    // pairing all stay closed (a paired non-owner previously reached RAG and the
    // base prompt, leaking the existence of gated content). The owner always
    // passes (owner_id match). Gated on owner_id existing so the
    // first-/start-becomes-owner bootstrap on a fresh install is preserved —
    // before an owner exists there is nothing to protect. The reject reveals
    // nothing: no content, no "owner", no pairing hint.
    //
    // Scoped to un-routed traffic (`!routeAs`): a real Telegram message is never
    // mode-classified (Telegram sets no routeAs — only Beeper's adapter does), so
    // this fires for 100% of genuine Telegram traffic — the command / implicit-ask
    // / upload path that leaked. A message carrying a routeAs was classified by a
    // platform adapter and is governed by its own owner/customer logic below.
    if (msg.platform === 'telegram' && !msg.routeAs && config.owner_id && !isOwner(msg.senderId, config, msg)) {
      // Audit the FIRST reject per sender so probing is visible, but dedupe so a
      // spammer can't flood the append-only log (one line per sender, not per msg).
      if (!loggedTelegramRejects.has(msg.senderId)) {
        loggedTelegramRejects.add(msg.senderId);
        logAudit({ action: 'telegram_reject', user_id: msg.senderId, sender_name: msg.senderName, chatId: msg.chatId, platform: 'telegram' });
      }
      await platform.send(msg.chatId, 'This is a private assistant.');
      return;
    }

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
          // An owner-ask (M10) that timed out records its terminal "expired" outcome
          // so the request can't dangle, then announces it once. Other parked kinds
          // just announce — a late reply must not fall through to the RAG pipeline as
          // a search query (the orphaned-reply bug this de-tangle exists to kill).
          if (entry.kind === ASK_KIND) {
            await expireAsk(entry, { platform, getMem, chatId: msg.chatId, rememberEpisode });
            return;
          }
          await platform.send(msg.chatId, entry.expireMsg
            || 'That prompt expired — please re-send the command.');
          return;
        }
        switch (entry.kind) {
          case ASK_KIND: {
            // The one owner-ask dispatcher (M10): owns cancel / stick / handle /
            // re-park / record for EVERY ask type (ceremony, pickers, wizards). Pass
            // the RAW text — the dispatcher trims and the ask's accepts()/handle()
            // interpret it. A /command-cancel returns { fallThrough } so the command
            // routes normally (the pickers' prior escape UX); everything else is
            // consumed here.
            const res = await resumeAsk(entry, text, { pending, platform, getMem, chatId: msg.chatId, senderId: msg.senderId, rememberEpisode });
            if (res && res.fallThrough) break;
            return;
          }
          case 'gate_reply':
            // A parked bareguard challenge (approval/PIN/CONFIRM) is awaiting this
            // reply. Hand it the RAW text — the challenge interprets yes/no/PIN/
            // CONFIRM itself — and it self-clears via the resolver.
            entry.resolve(text);
            return;
          // (The 'pin_command' router-PIN resume was retired with PIN_PROTECTED —
          // exec/read/index now ceremony inside the M9 governed core, whose PIN
          // reply parks as a 'gate_reply' waiter, handled above.)
          //
          // The PIN ceremony, the index + mode pickers, the business menu + setup
          // wizard, and the /pin change wizard are all migrated to ASK_KIND (the one
          // dispatcher above). gate_reply (the bareguard approval/PIN challenge) is
          // the last bespoke holdout — it self-clears via its parked resolver.
        }
      }
    }

    // Off mode: defense-in-depth — no logging, no processing
    if (msg.routeAs === 'off') return;

    // Silent mode: observe only — log + record as a memory episode, no response.
    if (msg.routeAs === 'silent') {
      const admin = isOwner(msg.senderId, config, msg);
      const mem = getMem(msg.chatId, { isAdmin: admin });
      if (mem) {
        const role = msg.isSelf ? 'user' : 'contact';
        mem.appendToLog(role, msg.text);

        // Persist chat metadata to config.chats
        if (msg.chatName || msg.network) {
          const fields = { platform: msg.platform };
          if (msg.chatName) fields.name = msg.chatName;
          if (msg.network) fields.network = msg.network;
          updateChatMeta(config, msg.chatId, fields);
        }

        // The observed message → a memory episode; then sweep hot episodes → facts.
        await rememberEpisode(admin, msg.chatId, [{ role, content: msg.text }]);
        sweepPromotions(admin, msg.chatId);
      }
      return;
    }

    // Natural language / business / personal routing (set by platform adapter)
    if (msg.routeAs === 'natural' || msg.routeAs === 'business' || msg.routeAs === 'personal') {
      // Business/personal: a contact can get a response (via Beeper). Natural: paired users (the owner)
      // only. Personal replies are fenced to user:<chatId> in routeAsk (isOwner is false in a contact
      // room) and carry no business persona — the base assistant prompt (M8 §524, owner-decided).
      if (msg.routeAs === 'natural' && !isPaired(msg, config) && !isOwner(msg.senderId, config, msg)) return;

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
          if (mem) {
            mem.appendToLog('user', msg.text);
            await rememberEpisode(true, msg.chatId, [{ role: 'user', content: msg.text }]);
          }
          return;
        }
        if (isAdminPaused(msg.chatId)) {
          // Customer messages while admin is active → silently archive, no LLM
          const mem = getMem(msg.chatId, { isAdmin: false });
          if (mem) {
            mem.appendToLog('user', msg.text);
            await rememberEpisode(false, msg.chatId, [{ role: 'user', content: msg.text }]);
          }
          return;
        }

        // Per-customer rate limit. On the cap we archive the message, hand off
        // to a human, and stop the LLM — degrade, don't refuse (#1).
        if (rateLimiter) {
          const verdict = rateLimiter.consume(msg.senderId);
          if (!verdict.allowed) {
            const mem = getMem(msg.chatId, { isAdmin: false });
            if (mem) {
              mem.appendToLog('user', msg.text);
              await rememberEpisode(false, msg.chatId, [{ role: 'user', content: msg.text }]);
            }
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

      await routeAsk(msg, platform, config, indexer, provider, msg.text, getMem, memCfg, agentRegistry, { allTools, toolsConfig, runtimePlatform, maxToolRounds, platformRegistry, gov, pending });
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

    // Auth check for all other commands.
    if (!isPaired(msg, config) && !isOwner(msg.senderId, config, msg)) {
      if (msg.platform === 'telegram') {
        await platform.send(msg.chatId, 'You are not paired. Send /start <pairing_code> to pair.');
      }
      return;
    }

    // No router-level PIN gate here any more. The M9 governed core
    // (runGovernedAction) is the single floor + ceremony: exec ceremonies by
    // command severity, read/index by the owner floor — all at dispatch time,
    // with one PendingRegistry. The old PIN_PROTECTED double-path is retired.

    await executeCommand(command, args, msg, platform, config, indexer, provider, getMem, memCfg, pinManager, agentRegistry, { indexer, provider, memCfg, allTools, toolsConfig, runtimePlatform, maxToolRounds, platformRegistry, gov, pending });
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
      case 'exec':
        await routeExec(msg, platform, config, args, toolDeps);
        break;
      case 'read':
        await routeRead(msg, platform, config, args, toolDeps);
        break;
      case 'index':
        await routeIndex(msg, platform, config, indexer, args, toolDeps);
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
        await routeMemory(msg, platform, config, getMem, toolDeps);
        break;
      case 'forget':
        await routeForget(msg, platform, config, getMem, args, toolDeps);
        break;
      case 'remember':
        await routeRemember(msg, platform, config, getMem, args, toolDeps);
        break;
      case 'mode':
        await routeMode(msg, platform, config, args, agentRegistry, { ...toolDeps, getMem });
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
        await routeHelp(msg, platform, config, args);
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
// The /pin change wizard as a multi-step owner-ask (M10): verify → new. Carries a
// digit-only `match` so a non-digit reply (a command, a stray message) falls
// through to normal routing rather than being consumed — the wizard's prior
// "type a command to step away" behaviour. The mutable `step` advances via { next }.
function makePinChangeAsk({ msg, platform, config, pinManager, step }) {
  const ask = {
    kind: 'pin_change',
    request: null, isOwner: true,
    step,
    match: (t) => /^\d{4,6}$/.test(String(t).trim()),
    expireMsg: 'PIN change timed out — send /pin to start over.',
    accepts: (t) => /^\d{4,6}$/.test(t), // guaranteed by `match`, but explicit
    handle: async (pin) => {
      if (ask.step === 'verify') {
        const result = pinManager.authenticate(msg.senderId, pin);
        if (!result.success) {
          await platform.send(msg.chatId, result.reason);
          // A lockout is terminal (clear); a plain wrong PIN re-parks for a retry.
          return result.locked ? { done: true, summary: null } : { retry: true };
        }
        ask.step = 'new';
        await platform.send(msg.chatId, 'Enter your new PIN (4-6 digits):');
        return { next: ask };
      }
      // step 'new' — `match` already guaranteed a 4–6 digit PIN.
      config.security.pin_hash = hashPin(pin);
      saveConfig(config);
      await platform.send(msg.chatId, 'PIN updated successfully.');
      logAudit({ action: 'pin_change', user_id: msg.senderId });
      return { done: true, summary: null };
    },
  };
  return ask;
}

async function routePinChange(msg, platform, config, pinManager, pending) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  const step = pinManager.isEnabled() ? 'verify' : 'new';
  await platform.send(msg.chatId, step === 'verify'
    ? 'Enter your current PIN:'
    : 'No PIN set. Enter a new PIN (4-6 digits):');
  await openAsk(makePinChangeAsk({ msg, platform, config, pinManager, step }),
    { pending, chatId: msg.chatId, senderId: msg.senderId });
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

/**
 * Run a declared capability through the single M9 governed core
 * (runGovernedAction): floor → arg-validation → classify → ceremony → execute →
 * audit. Both the slash app-verbs and (later) the LLM tool path resolve here, so
 * a host action ceremonies exactly once, via one PendingRegistry — no second,
 * parallel PIN path. Returns the core's tagged result for the caller to render.
 */
async function dispatchCapability(capName, args, msg, config, toolDeps = {}, ceremonyReply) {
  const { gov } = toolDeps;
  const bundle = gov ? await gov.resolve() : {};
  const deps = buildSlashDeps(bundle, config, toolDeps);
  const ctx = buildGovernCtx(msg, config);
  return runGovernedAction({ capability: capName, args, ctx, deps, ceremonyReply });
}

// The governed-action ctx for the slash door — single-sourced so the initial
// dispatch and the parked ceremony's resume build the identical ctx.
function buildGovernCtx(msg, config) {
  return {
    senderId: msg.senderId,
    chatId: msg.chatId,
    isOwner: isOwner(msg.senderId, config, msg),
    platform: msg.platform,
  };
}

// The governed-action deps for the slash door (full floor + appExec + ceremony).
// verifyPin = park-and-resume (no inline await → no serial-poll deadlock).
function buildSlashDeps(bundle, config, toolDeps) {
  const { indexer, getMem, provider, memCfg } = toolDeps;
  return buildGovernDeps({
    verifyPin: bundle.verifyPin,
    pinConfigured: bundle.pinConfigured,
    floorPolicy: bundle.floorPolicy,
    denylist: bundle.denylist,
    indexer,
    appExec: buildAppExec(config, getMem, indexer, provider, memCfg),
  });
}

/**
 * Build a PIN-ceremony ask (M10 §4) — the single "run this capability with this
 * PIN" object both doors construct. The factory owns the shared structure:
 *   - showPrompt → ceremonyPrompt (the lockout-aware PIN prompt)
 *   - accepts    → a 4–6 digit PIN
 *   - handle     → runGovernedAction(…, ceremonyReply) once, mapped to one outcome
 *
 * Presentation is the ONE thing that legitimately differs per door, so each door
 * passes a `render(result)` that owns its exact user-facing wording (the slash
 * door's "PIN accepted." + onResume/format; the LLM door's single concatenated
 * bubble). The dispatcher then owns cancel/stick/record/expire for this ask like
 * any other. `request` is the conversational text to record at completion (LLM
 * door) or null for a slash command (a command is not conversation).
 */
function makeCeremonyAsk({ capability, args, ctx, deps, ceremonyPrompt, echo, request, ttlMs, render }) {
  const defaultSummary = (r) => {
    if (r.kind === RESULT.OK) return isSilentSuccess(r.result) ? '✓ done' : String(r.result);
    if (/lock/i.test(r.message || '')) return 'didn\'t run — locked out';
    return 'didn\'t run';
  };
  return {
    kind: 'ceremony',
    request: request || null,
    label: echo || null,
    isOwner: !!ctx.isOwner,
    ttlMs,
    expireMsg: 'That PIN prompt expired — re-send the command if you still want it.',
    stickHint: 'Reply with your PIN (4–6 digits), or "cancel".',
    showPrompt: async () => (ceremonyPrompt
      ? ceremonyPrompt({ senderId: ctx.senderId, chatId: ctx.chatId, platform: ctx.platform }, { echo })
      : 'no-channel'),
    accepts: (text) => /^\d{4,6}$/.test(text),
    handle: async (reply) => {
      const r2 = await runGovernedAction({ capability, args, ctx, deps, ceremonyReply: reply });
      await render(r2); // door-specific user-facing output (already-sent chat lines)
      // A wrong PIN with attempts remaining is retryable → re-park the SAME ask.
      if (r2.kind === RESULT.DENIED && r2.retry === true) return { retry: true };
      // Everything else is terminal (success, lockout, no-verifier, floor) → record.
      return { done: true, summary: defaultSummary(r2) };
    },
  };
}

/**
 * Execute bindings for the config/memory-coupled app-verbs, bound here where
 * config + setChatMode + getMem are in scope (deps.js stays a pure binder, no
 * circular import). The core has already applied the floor + ceremony before
 * any of these run. The getMem-backed verbs are only reachable from routes that
 * pass getMem in toolDeps (forget/remember/memory), so the closures are safe.
 */
function buildAppExec(config, getMem, indexer, provider, memCfg) {
  const mem = (ctx) => getMem(ctx.chatId, { isAdmin: ctx.isOwner });
  const scopeOf = (ctx) => (ctx.isOwner ? 'admin' : `user:${ctx.chatId}`);
  return {
    // set_mode commits the resolved (chatId, mode) — off ceremonies via the core.
    set_mode: (args) => { setChatMode(config, args.target, args.mode); return { target: args.target, mode: args.mode }; },
    // forget: `args.id` present → delete that ONE note precisely (targeted /forget), cascading a
    // promoted fact to its source episode so it can't rebound (see context.forgetById). Absent → wipe
    // this tenant's whole durable memory (fact+episode, tenant-fenced) — the episodes ARE the
    // conversation thread now, so a full forget clears the window too. Raw daily logs are kept by design.
    forget:   async (args, ctx) => {
      const scope = scopeOf(ctx);
      if (args.id) { const removed = await indexer.forgetMemoryById(scope, args.id); return { chatId: ctx.chatId, id: args.id, removed }; }
      const removed = await indexer.forgetMemory(scope); return { chatId: ctx.chatId, all: true, removed };
    },
    // remember = a deliberate durable fact (by:'human', top trust), tenant-fenced. W4: if the note
    // RESTATES-AND-UPDATES an existing fact, the judge overwrites it in place instead of piling up a
    // contradiction (degrades to a plain new-fact write when superseding is off / no provider).
    remember: async (args, ctx) => {
      const r = await rememberWithSupersede({ indexer, provider, scope: scopeOf(ctx), note: args.note, memCfg });
      return { note: args.note, superseded: r.superseded, supersededText: r.supersededText };
    },
    // memory = this chat's recent memory, newest-first: durable facts AND scratchpad episodes
    // (litectx 0.23.0 recentMemory, tenant-fenced), with a per-kind count header (O1 count()).
    memory:   async (args, ctx) => {
      const scope = scopeOf(ctx);
      const [hits, facts, episodes] = await Promise.all([
        indexer.recentMemory(scope, { kind: ['fact', 'episode'], n: 20 }),
        indexer.countMemory(scope, { kind: 'fact' }),
        indexer.countMemory(scope, { kind: 'episode' }),
      ]);
      return { memory: hits.map((h) => `[${h.kind}] ${h.content}`).join('\n'), summary: `${facts} fact(s), ${episodes} episode(s)` };
    },
  };
}

/**
 * Map a bareguard floor-deny verdict string to a readable, non-leaky line.
 * The raw verdict (rule name + matched regex) stays in gate.jsonl for forensics;
 * the owner just sees why it was blocked, in plain language.
 */
function friendlyFloorDeny(raw) {
  const s = String(raw || '');
  if (/fs\.deny|\bpath\b/i.test(s)) return '⛔ Blocked: that path is off-limits.';
  if (/shellMeta|metacharacter/i.test(s)) return "⛔ Blocked: that command uses shell special characters I can't run safely — simplify it, or run it yourself in a terminal.";
  if (/denyPatterns|catastrophic/i.test(s)) return '⛔ Blocked: that command is too dangerous to run through me — please do it yourself in a terminal.';
  if (/bash\.allow|not in|allowlist/i.test(s)) return "⛔ Blocked: that command isn't on the allowed list.";
  return '⛔ Blocked by safety policy.';
}

/**
 * Render a governed-core result to the user. `format(result)` shapes the OK
 * text; `usage` shows when a required arg is missing/invalid (the picker
 * stand-in for the slash door). DENIED maps the owner floor and a declined
 * ceremony to plain language.
 */
// A command that succeeded with no stdout (executor.js renders that as
// "(no output)") needs no result line after a "PIN accepted." — the confirmation
// already says it ran. Standalone benign exec still shows "(no output)" (there it's
// the only feedback); this only trims the redundant tail in a ceremony resume.
function isSilentSuccess(result) {
  const s = result == null ? '' : String(result).trim();
  return s === '' || s === '(no output)';
}

async function sendCapabilityResult(r, platform, msg, opts = {}) {
  if (r.kind === RESULT.OK) {
    const text = opts.format ? opts.format(r.result) : String(r.result ?? '(done)');
    await platform.send(msg.chatId, text);
    return;
  }
  if (r.kind === RESULT.NEEDS_ARG) {
    await platform.send(msg.chatId, opts.usage || `Missing required input: ${(r.missing || []).join(', ')}`);
    return;
  }
  if (r.kind === RESULT.DENIED) {
    if (r.reason === 'owner_only') {
      await platform.send(msg.chatId, opts.ownerOnly || 'Owner only command.');
    } else if (r.reason === 'catastrophic_blocked') {
      await platform.send(msg.chatId, '⛔ Blocked: that command is too destructive to run through me — please do it yourself in a terminal.');
    } else if (/_ceremony_declined$/.test(r.reason || '')) {
      // r.message carries the verifier's reason (e.g. "Wrong PIN. N attempts
      // remaining."). When `retry` is set the ceremony is RE-PARKED (the caller
      // re-adds it), so don't say "Action cancelled" — the owner can try again.
      // A terminal decline (lockout / no verifier) ends with "Action cancelled."
      const tail = r.retry ? '' : '\nAction cancelled.';
      await platform.send(msg.chatId, r.message ? `${r.message}${tail}` : 'Action cancelled.');
    } else {
      // floor deny (Axis-A) — bareguard's raw verdict (e.g.
      // "[deny: content.denyPatterns] matched /\brm\s+-rf\s+\//") is an internal
      // rule string and already recorded in gate.jsonl. Show the owner a readable
      // line instead of leaking the regex/rule name into chat.
      await platform.send(msg.chatId, friendlyFloorDeny(r.message));
    }
    return;
  }
  if (r.kind === RESULT.NEEDS_CEREMONY) {
    // Defensive: a destructive result reached the plain renderer instead of
    // handleCeremonyOrSend. Don't silently drop it — tell the owner to re-send.
    await platform.send(msg.chatId, 'That action needs your PIN — please re-send the command.');
    return;
  }
  // UNKNOWN — no such capability (shouldn't happen from a fixed slash route).
  await platform.send(msg.chatId, 'Unknown command.');
}

/**
 * Render a governed-core result, but if it's NEEDS_CEREMONY, drive the
 * park-and-resume flow via the one ask dispatcher (M10): build a ceremony ask,
 * `openAsk` it (prompt + park on the shared PendingRegistry), and RETURN (never
 * blocking the poll loop). The PIN reply lands on the ASK_KIND dispatch case →
 * `resumeAsk` → the ask's `handle` re-runs the capability with `ceremonyReply`.
 * `opts` mirrors sendCapabilityResult's (usage/format/ownerOnly) plus
 * { capName, args, onResume } for the resume render, and an optional { echo } that
 * overrides the prompt line with a human-readable label (so an app-verb shows
 * "Amora → off", not the raw room id). run_shell omits it → the verbatim command
 * is shown, which is the security-relevant thing for shell. A slash command is not
 * conversation, so the ask carries no `request` → nothing is recorded to memory.
 */
async function handleCeremonyOrSend(r, platform, msg, config, toolDeps, opts = {}) {
  if (r.kind !== RESULT.NEEDS_CEREMONY) {
    await sendCapabilityResult(r, platform, msg, opts);
    return;
  }
  const { gov, pending } = toolDeps;
  if (!pending) return; // no registry → can't resume; fail-closed
  const bundle = gov ? await gov.resolve() : {};
  const ctx = buildGovernCtx(msg, config);
  const deps = buildSlashDeps(bundle, config, toolDeps);
  const ask = makeCeremonyAsk({
    capability: opts.capName, args: opts.args, ctx, deps,
    ceremonyPrompt: bundle.ceremonyPrompt,
    echo: opts.echo || r.echo,
    request: null, // a slash command is not conversation — record nothing
    ttlMs: (config?.security?.pin_prompt_timeout || 300) * 1000,
    // "PIN accepted." then onResume / format / result. A silent success (a command
    // with no stdout, e.g. `rm`) gets an explicit "✓ Done." so success is confirmed
    // the way a failure shows its error — restoring the confirmation the "(no
    // output)" polish removed (M10 §5). onResume / format callers send their own.
    render: async (r2) => {
      if (r2.kind === RESULT.OK) await platform.send(msg.chatId, 'PIN accepted.');
      if (opts.onResume) await opts.onResume(r2);
      else if (r2.kind === RESULT.OK && isSilentSuccess(r2.result)) await platform.send(msg.chatId, '✓ Done.');
      else await sendCapabilityResult(r2, platform, msg, opts);
    },
  });
  const status = await openAsk(ask, { pending, chatId: msg.chatId, senderId: msg.senderId });
  if (status === 'no-channel') {
    await platform.send(msg.chatId, 'Could not prompt for the required PIN — action cancelled.');
  }
  // 'locked' already messaged the lockout line inside ceremonyPrompt; 'prompted' is parked.
}

async function routeExec(msg, platform, config, command, toolDeps = {}) {
  // run_shell: the core applies the owner floor first (non-owner → owner_only),
  // then arg-validation (empty → usage), then dynamic shell-severity ceremony —
  // benign runs free, destructive → PIN, catastrophic → PIN+CONFIRM.
  const args = { command: command || '' };
  const r = await dispatchCapability('run_shell', args, msg, config, toolDeps);
  await handleCeremonyOrSend(r, platform, msg, config, toolDeps, { capName: 'run_shell', args, usage: 'Usage: /exec <command>' });
}

async function routeRead(msg, platform, config, filePath, toolDeps = {}) {
  // read_file: owner-floor only (benign — no ceremony). The old router-level PIN
  // on /read is retired; the core is the single floor.
  const r = await dispatchCapability('read_file', { path: filePath || '' }, msg, config, toolDeps);
  await sendCapabilityResult(r, platform, msg, { usage: 'Usage: /read <path>' });
}

// Parse `/index <path> <public|admin>` into the registry's scope vocab.
// `/index <path>` reads from the HOST filesystem (indexFile -> fs.readFileSync)
// AND plants the bytes into the world-readable KB, so the capability is declared
// owner-only — the core enforces that floor. Customers contribute by uploading a
// file in chat (a scoped upload), never via a host path.
// Registry scope vocab: 'kb' = the public KB, 'admin' = owner-private. We accept
// the user words public|kb|admin and normalise; null scope → ask for the role.
// One renderer for an ingest outcome so a 0-chunk / blob result reads as "stored
// but not searchable" instead of a misleading "Indexed 0 chunks". Takes litectx's
// {chunks, mode} ('chunked' = searchable; 'blob' = stored-only, not recallable).
function indexOutcomeMsg({ chunks, mode }, name, scope) {
  if (mode === 'blob' || !chunks) return `Stored ${name} [${scope}] — saved but not searchable (no text chunks).`;
  return `Indexed ${chunks} chunk${chunks === 1 ? '' : 's'} from ${name} [${scope}]`;
}

function parseIndexArgs(args) {
  if (!args || !args.trim()) return null;
  const parts = args.trim().split(/\s+/);
  const roleToken = { public: 'kb', kb: 'kb', admin: 'admin' };
  const last = parts[parts.length - 1].toLowerCase();
  let scope = null;
  let fileParts = parts;
  if (parts.length >= 2 && roleToken[last]) {
    scope = roleToken[last];
    fileParts = parts.slice(0, -1);
  }
  const display = fileParts.join(' ');
  const path = display.replace(/^~/, process.env.HOME || process.env.USERPROFILE);
  return { scope, path, display };
}

async function routeIndex(msg, platform, config, indexer, args, toolDeps = {}) {
  const parsed = parseIndexArgs(args);
  if (!parsed) {
    await platform.send(msg.chatId, 'Usage: /index <path> <public|admin>');
    return;
  }
  if (!parsed.scope) {
    await platform.send(msg.chatId, 'Please specify role: public (knowledge base) or admin (owner-only).\nExample: /index ~/doc.pdf public');
    return;
  }
  // Progress ping is a display nicety, gated on owner so a non-owner doesn't see
  // "Indexing…" before the core's owner floor denies them. The core remains the
  // single enforcement floor — this is UX, not a second authz check.
  if (isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, `Indexing: ${parsed.display} (${parsed.scope === 'admin' ? 'admin' : 'public'})...`);
  }
  let r;
  try {
    r = await dispatchCapability('index', { path: parsed.path, scope: parsed.scope }, msg, config, { ...toolDeps, indexer });
  } catch (err) {
    await platform.send(msg.chatId, `Index error: ${err.message}`);
    return;
  }
  await sendCapabilityResult(r, platform, msg, {
    format: (res) => indexOutcomeMsg({ chunks: res.count, mode: res.mode }, parsed.display, res.role),
    ownerOnly: 'Owner only command.',
  });
}

async function routeSearch(msg, platform, config, indexer, query) {
  if (!query) {
    await platform.send(msg.chatId, 'Usage: /search <query>');
    return;
  }

  const admin = isOwner(msg.senderId, config, msg);
  // Owner /search recalls admin ∪ global-KB; a customer recalls own ∪ global-KB.
  // litectx recall(scope) returns scope ∪ null-global, so a customer (user:*) chunk
  // can never enter another customer's or the owner's results (#6).
  const scope = admin ? 'admin' : `user:${msg.chatId}`;
  const results = await indexer.search(query, { scope, n: 5 });

  if (results.length === 0) {
    await platform.send(msg.chatId, 'No results found.');
    return;
  }

  const formatted = results.map((r, i) => {
    const preview = r.content.slice(0, 200).replace(/\n/g, ' ');
    return `${i + 1}. ${r.name}\n${preview}...`;
  });

  await platform.send(msg.chatId, formatted.join('\n\n'));
  logAudit({ action: 'search', user_id: msg.senderId, query, results: results.length });
  // litectx self-tracks recall demand-signal; no manual access recording needed.
}

async function routeDocs(msg, platform, config, indexer) {
  // stats() is a process-wide count across ALL scopes (docs + memory for every
  // tenant). litectx exposes no per-scope count, so the figure is global — gate it
  // to the owner rather than leak the cross-tenant total to a customer.
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }
  const stats = indexer.stats();
  const line = `Indexed items: ${stats.total}`;
  await platform.send(msg.chatId, stats.total ? line : 'No documents indexed yet.');
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
/**
 * Wrap one bare-agent-adapted tool so its execute runs through the M9 governed
 * core (runGovernedAction) — but only for a capability that can require a ceremony
 * (dynamic/destructive/catastrophic severity; today that's `exec`/run_shell).
 * Benign or unmapped tools are returned unchanged: the Loop's `policy` already
 * floors them and they need no ceremony, so routing them through the core would
 * only add a redundant audit line. The core gets NO floor dep here (the Loop's
 * policy is the floor) and delegates execute back to the adapted tool, preserving
 * its tool_call audit. A declined ceremony / floor deny becomes a plain tool
 * result the model reports; it never silently runs.
 */
function wrapToolThroughCore(adaptedTool, govCtx, { verifyPin, pinConfigured, ceremonyPrompt, pending, platform, denylist, ceremonyTtlMs }) {
  const cap = getCapabilityForTool(adaptedTool.name);
  if (!cap || cap.severity === SEVERITY.BENIGN) return adaptedTool; // policy is the sole gate
  const original = adaptedTool.execute;
  const deps = buildGovernDeps({
    verifyPin,
    pinConfigured,
    denylist,
    // No floorPolicy: the Loop's policy already enforced Axis-A before execute.
    execute: (_cap, args) => original(args), // delegate → adapter (tool_call audit + tool.execute)
  });
  const renderDenied = (r) => {
    if (r.reason === 'owner_only') return 'Denied: this action requires owner privileges.';
    if (r.reason === 'catastrophic_blocked') return 'Blocked: that command is too destructive to run through me — please do it yourself in a terminal.';
    if (/_ceremony_declined$/.test(r.reason || '')) return r.message || 'Action cancelled — the required PIN was not provided.';
    return r.message || 'Denied by governance.';
  };
  return {
    ...adaptedTool,
    execute: async (args) => {
      const r = await runGovernedAction({ capability: cap, args: args || {}, ctx: govCtx, deps });
      if (r.kind === RESULT.OK) return r.result;
      if (r.kind === RESULT.NEEDS_ARG) {
        return `Missing required argument(s): ${(r.missing || []).join(', ')}. Provide them and retry.`;
      }
      if (r.kind === RESULT.NEEDS_CEREMONY) {
        // Park-and-resume on the LLM door: NEVER block the Loop awaiting the PIN (a
        // serial Beeper poll loop would deadlock). Prompt, park the action, and end
        // this turn; the PIN reply runs it AFTER the turn (M9: destructive execution
        // is decoupled from the model's reasoning). Needs an interactive channel +
        // the shared registry; background jobs (cron/plan) pass neither → fail-closed.
        if (!pending || !platform) return 'That action needs your PIN, which I can\'t collect here. Re-send it as /exec <command>.';
        // One ask, one dispatcher (M10). The conversational `request` (the user's NL
        // turn) rides the ask so the dispatcher records (request → outcome) at the PIN
        // reply — closing the replay bug where a parked turn dangled in recent.json.
        const ask = makeCeremonyAsk({
          capability: cap, args: args || {}, ctx: govCtx, deps,
          ceremonyPrompt, echo: r.echo,
          request: govCtx.requestText || null,
          ttlMs: ceremonyTtlMs || 300_000,
          // A silent success (a command with no stdout, e.g. `rm`) still needs a
          // confirmation it RAN — otherwise "PIN accepted." alone leaves the owner
          // unsure, while a FAILURE shows its error. "✓ Done." restores the
          // confirmation the "(no output)" polish removed (M10 §5).
          render: async (r2) => {
            const out = r2.kind === RESULT.OK
              ? (isSilentSuccess(r2.result) ? 'PIN accepted.\n✓ Done.' : `PIN accepted.\n${String(r2.result)}`)
              : renderDenied(r2);
            try { await platform.send(govCtx.chatId, out); } catch { /* ignore */ }
          },
        });
        const status = await openAsk(ask, { pending, chatId: govCtx.chatId, senderId: govCtx.senderId });
        // Locked out: the ceremony prompt already sent the "Locked out…" line to chat
        // (createCeremonyPrompt). HALT the turn instead of returning a tool-result
        // string the Loop would feed back for the model to RE-NARRATE — that double
        // "locked out" message is the wart a live test surfaced. Same clean-exit
        // pattern as the parked path below; the canned line IS the user-facing signal.
        if (status === 'locked') throw new HaltError('ceremony locked out', { rule: 'ceremony-locked' });
        if (status !== 'prompted') return 'Could not prompt for the required PIN — action cancelled.';
        // END THE TURN. The PIN prompt is already sent and the action is parked; if
        // we returned a tool-result string the Loop would feed it to the model and
        // keep going — a model that keeps reasoning/re-calling then re-prompts and
        // re-parks every round until limits.maxToolRounds halts it (the NL-door bug,
        // 2026-06-24). Throw HaltError straight from the tool body: bare-agent ≥0.18.0
        // re-throws a HaltError out of the per-tool execute catch like every other
        // seam (the fix multis filed under M9), so the Loop exits cleanly with
        // error 'halt:ceremony-parked' (onError skips it by rule; runAgentLoop
        // swallows it — the prompt IS the user-facing signal). No onToolResult shim.
        throw new HaltError('ceremony parked for PIN', { rule: 'ceremony-parked' });
      }
      if (r.kind === RESULT.DENIED) return renderDenied(r);
      return 'Action could not be completed.';
    },
  };
}

async function runAgentLoop(agentProvider, messages, tools, opts = {}) {
  // maxRounds removed in bare-agent 0.10 — round caps live in the bareguard
  // Gate as limits.maxToolRounds, derived from config.llm.max_tool_rounds.
  // Don't accept maxRounds here so callers don't think it has any effect.
  const { system, ctx, config, gov } = opts;
  const adapted = adaptTools(tools, ctx);

  // Resolve governance lazily on first call (ESM bareguard requires await import)
  const bundle = gov ? await gov.resolve() : {};
  const { policy, onLlmResult, onToolResult, verifyPin, pinConfigured, ceremonyPrompt, denylist } = bundle;

  // M9 increment 3 — the LLM door through the one governed core. A tool whose
  // capability can require a ceremony (today: `exec`/run_shell, dynamic severity)
  // runs its execute through runGovernedAction, so the destructive/catastrophic PIN
  // (+CONFIRM) ceremony lives in the SAME core as the slash door — never again in
  // gate.js `policy`. The Loop's `policy` already enforced the Axis-A floor before
  // execute (bash.allow ∪ denylist lets a destructive command reach here), so the
  // core runs WITHOUT a floor dep (no double gate.check) and delegates execute back
  // to the bare-agent-adapted tool (preserving its tool_call audit). Benign/unknown
  // tools are left unwrapped — `policy` is their sole gate.
  const govCtx = {
    senderId: ctx.senderId,
    chatId: ctx.chatId,
    isOwner: ctx.isOwner,
    platform: ctx.platform?.name || ctx.platform?.platform || ctx.platformName,
    // The conversational request driving this turn — rides a parked ceremony ask so
    // the dispatcher records (request → outcome) at the PIN reply (M10 §5).
    requestText: ctx.requestText || null,
  };
  // Park-and-resume needs the shared registry + an interactive channel to prompt
  // and to deliver the deferred result. Present on the interactive /ask path; absent
  // on background jobs (cron/plan), where a destructive tool fails-closed instead.
  const governed = gov
    ? adapted.map((t) => wrapToolThroughCore(t, govCtx, {
        verifyPin, pinConfigured, ceremonyPrompt, denylist,
        pending: ctx.pending,
        platform: ctx.platform,
        ceremonyTtlMs: (config?.security?.pin_prompt_timeout || 300) * 1000,
      }))
    : adapted;

  // Build retry + circuit breaker from config
  const retryCfg = config?.llm?.retry || {};
  const retry = new Retry({
    maxAttempts: retryCfg.maxAttempts || 3,
    timeout: retryCfg.timeout || 30000,
  });
  const cb = getCircuitBreaker(config);
  const wrappedProvider = cb.wrapProvider(agentProvider, config?.llm?.provider || 'default');

  // A tool that parks a PIN ceremony throws HaltError straight from its execute
  // body (wrapToolThroughCore); bare-agent ≥0.18.0 re-throws it out of the per-tool
  // catch like every other seam, so the Loop exits cleanly on 'halt:ceremony-parked'
  // with no onToolResult shim. onToolResult is now just bareguard's gate.record.

  // M5 context-engineering — budget-fit the running transcript each round via litectx's `assemble`
  // (bare-agent's unitAssembler adapts the units verb to the Loop's msgs-level seam). Keeps the newest
  // turns + the auto-pinned system/task within config.memory.context_budget tokens, drops oldest history
  // first, never splits a tool-call/result bundle. Only wired when a budget is set (0/null → full
  // context, pre-M5 behavior). The hook is a non-destructive VIEW (result.msgs stays complete, so episode
  // recording is unaffected) and fail-open (an assemble fault sends full context, never halts).
  const contextBudget = config?.memory?.context_budget;
  const assemble = contextBudget
    ? unitAssembler(async (units) => {
        const r = await context.assembleUnits(units, { budget: contextBudget });
        // Silent on a normal turn (nothing dropped); logs only when budget pressure actually engages —
        // an ops signal that a turn grew past context_budget and old history was shed to fit.
        if (r.dropped.length) {
          console.error(`[context] budget-fit: shed ${r.dropped.length} of ${units.length} units → ${r.tokens} tok (budget ${contextBudget})`);
        }
        return r;
      })
    : null;

  // "Always ask" confirms (e.g. before every exec) are governed by bareguard's
  // flags primitive inside `policy`, routed through the single humanChannel —
  // no separate Checkpoint. governance = bareguard, one path.
  const loop = new Loop({
    provider: wrappedProvider,
    system,
    retry,
    policy,
    assemble,
    onLlmResult,
    onToolResult,
    throwOnError: false,
    onError: (err, meta) => {
      // A ceremony halt — a PIN park or a lockout — ends the loop on purpose (the
      // tool body throws HaltError) — a clean governance exit, not an error. Don't
      // log it as loop_error (the message is already in chat; the govern line is the
      // real audit record).
      if (err?.rule === 'ceremony-parked' || err?.rule === 'ceremony-locked') return;
      logAudit({ action: 'loop_error', source: meta?.source, error: err?.message, chatId: ctx.chatId, user_id: ctx.senderId });
    },
  });

  // Pass _ctx through so humanChannel can route prompts back via platformRegistry.
  const result = await loop.run(messages, governed, {
    ctx: govCtx,
  });
  if (result.error) {
    // A ceremony halt — a destructive tool parked its PIN prompt, or the owner was
    // locked out (see wrapToolThroughCore). The user-facing line (the PIN prompt or
    // the "Locked out…" notice) is already in chat, so end quietly — surfacing a
    // tool-result string here would make the model re-narrate it (double message).
    if (result.error === 'halt:ceremony-parked' || result.error === 'halt:ceremony-locked') return '';
    // Other halt errors come back as `error: 'halt:<rule>'` strings — surface as a normal Error
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
    // Persist chat metadata. The user message is NOT appended here (M10 §5 rule 1):
    // a turn enters recent.json only when it COMPLETES, paired with its outcome. The
    // live request is handed to the loop as a message below; if the turn parks a
    // ceremony, the dispatcher records (request → outcome) at the PIN reply — so a
    // parked turn never dangles in recent.json and the model can't replay it.
    if (mem && (msg.chatName || msg.network)) {
      const fields = { platform: msg.platform };
      if (msg.chatName) fields.name = msg.chatName;
      if (msg.network) fields.network = msg.network;
      updateChatMeta(config, msg.chatId, fields);
    }

    // Search for relevant documents (scoped). Owner recalls admin ∪ global-KB; a
    // customer recalls own ∪ global-KB. litectx recall(scope) returns scope ∪
    // null-global, so customer-planted content can't surface in another customer's
    // or the owner's tool-enabled agent loop as trusted instructions (#6).
    const scope = admin ? 'admin' : `user:${msg.chatId}`;
    const chunks = await indexer.search(question, { scope, n: 5 });

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

    // Build the conversation thread from litectx episode recency (M4: no recent.json). Newest-first
    // → reverse to oldest-first, reconstruct role-tagged turns from each episode's meta.turns (litectx
    // never parsed the body), then bound to the recent_window most-recent turns.
    const recentEps = mem ? await indexer.recentMemory(memScopeFor(admin, msg.chatId), { kind: 'episode', n: memCfg.recent_window }) : [];
    const recent = [...recentEps].reverse().flatMap((h) => h.meta?.turns || []).slice(-memCfg.recent_window);
    // Durable memory: facts/episodes recalled for this tenant by relevance to the question,
    // formatted as notes for buildMemorySystemPrompt (which takes a string; empty = none).
    const memHits = mem ? await indexer.recallMemory(cleanQuestion, { scope: memScopeFor(admin, msg.chatId), n: 5 }) : [];
    const memoryMd = memHits.map((h) => `- ${h.content}`).join('\n');
    const system = buildMemorySystemPrompt(memoryMd, chunks, agentPersona);

    // Build messages array: recent history is past COMPLETED turns only (the live
    // request is no longer eagerly appended — M10 §5 rule 1).
    const messages = recent.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    // Hand the LIVE request to the loop as the final user turn. It is NOT in
    // recent.json yet — it enters conversation only at completion, paired with its
    // outcome (below, or via the dispatcher if a ceremony parks). cleanQuestion is
    // the @mention-stripped text the model sees; the original `question` is what's
    // recorded, for parity with the non-tool path.
    messages.push({ role: 'user', content: cleanQuestion });

    // --- Agent loop with tool calling ---
    const { allTools = [], toolsConfig: tCfg, runtimePlatform, maxToolRounds = 5, platformRegistry, gov, pending } = toolDeps;
    const userTools = getToolsForUser(allTools, admin, tCfg);
    // pending: the shared PendingRegistry, so a destructive tool on the LLM door can
    // park its PIN ceremony (park-and-resume) instead of blocking the loop.
    const ctx = { senderId: msg.senderId, chatId: msg.chatId, isOwner: admin, runtimePlatform, indexer, provider, memoryManager: mem, platform, platformName: msg.platform, config, platformRegistry, pending, requestText: question };

    const answer = await runAgentLoop(agentProvider, messages, userTools, {
      system,
      ctx,
      config,
      gov,
    });

    // Empty answer = a destructive tool parked its PIN ceremony and halted the turn
    // (runAgentLoop swallows 'halt:ceremony-parked' → ''). The PIN prompt is already
    // the only thing to say — don't post an empty bubble or record anything here. The
    // turn isn't complete: the dispatcher records (request → outcome) on the PIN reply
    // (M10 §5), so recent.json holds NOTHING about this turn while it's pending.
    if (!answer) return;

    // Reply prefix. M8 §525: CONTACT-facing replies (business + personal) carry a [Name] bot-disclosure
    // so the other party knows it's the bot, not the owner — an honest human/bot boundary. Owner/natural
    // replies are not disclosed (the owner knows their own assistant). Cosmetic only: echo-guard stays
    // client_tag (source:'api'), never the text — so this prefix can't be mistaken for the removed
    // [multis] echo marker. Owner-facing multi-agent keeps the which-agent-answered tag.
    const contactFacing = msg.routeAs === 'business' || msg.routeAs === 'personal';
    let prefixed;
    if (contactFacing) {
      prefixed = `[${config.assistant_name || 'multis'}] ${answer}`;
    } else if (agentRegistry && agentRegistry.size > 1) {
      prefixed = `[${resolved.name}] ${answer}`;
    } else {
      prefixed = answer;
    }

    await platform.send(msg.chatId, prefixed);

    // Record the COMPLETED exchange as a paired (request → answer) turn (M10 §5
    // rule 2). Written only now — never eagerly — so a turn that instead parked a
    // ceremony leaves no dangling request for the model to replay.
    if (mem) {
      mem.appendToLog('user', question);
      mem.appendToLog('assistant', answer);
      // The completed exchange → one memory episode (combined body = a coherent recall unit; meta.turns =
      // the role-tagged turns for window replay); then sweep hot episodes → durable facts (fire-and-forget).
      await rememberEpisodeFor(indexer, memCfg, admin, msg.chatId, [{ role: 'user', content: question }, { role: 'assistant', content: answer }]);
      sweepPromotionsFor(indexer, memCfg, admin, msg.chatId);
    }

    logAudit({ action: 'ask', user_id: msg.senderId, question, chunks: chunks.length, routeAs: msg.routeAs, agent: resolved.name });
    // litectx self-tracks recall demand-signal; no manual access recording needed.
  } catch (err) {
    await platform.send(msg.chatId, `LLM error: ${err.message || err}`);
  }
}

// memory/remember/forget run through the one governed core (audited there).
// forget is DESTRUCTIVE → the core requires the PIN ceremony before wiping memory
// (when a PIN is configured); remember/memory are benign and run straight through.
async function routeMemory(msg, platform, config, getMem, toolDeps = {}) {
  const r = await dispatchCapability('memory', {}, msg, config, { ...toolDeps, getMem });
  await sendCapabilityResult(r, platform, msg, {
    format: (res) => (res.memory && res.memory.trim())
      ? `Memory for this chat — ${res.summary}:\n\n${res.memory}`
      : 'No memory for this chat yet.',
  });
}

// Targeted /forget (M14): `forget <topic>` removes the matched note(s), not the whole scope. The
// number of matches picks the flow — 1 → straight to PIN; several → a read-only numbered picker,
// then PIN on the pick; 0 → an informational reply (no ceremony). `forget all` wipes everything with a
// strong warning; bare `/forget` prints the options (the old bare-nuke footgun is gone). Every DELETE
// still goes through the one governed core → PIN. The precise delete cascades a promoted fact to its
// source episode so it can't rebound (see context.forgetById).
async function routeForget(msg, platform, config, getMem, query, toolDeps = {}) {
  const td = { ...toolDeps, getMem };
  const { indexer, gov, pending } = td;
  const q = String(query || '').trim();
  const scope = isOwner(msg.senderId, config, msg) ? 'admin' : `user:${msg.chatId}`;
  const noteCount = async () => indexer.countMemory(scope, { kind: 'fact' }).catch(() => null);

  // bare /forget → options, NO destruction.
  if (!q) {
    const n = await noteCount();
    const have = (n != null) ? ` You have ${n} note(s).` : '';
    await platform.send(msg.chatId, `Say \`forget <topic>\` to remove specific notes (e.g. \`forget wedding\`), or \`forget all\` to erase everything in this chat.${have}`);
    return;
  }

  // /forget all | everything → whole-scope wipe, strong warning, PIN.
  if (/^(all|everything)$/i.test(q)) {
    const args = { target: 'everything' };
    const r = await dispatchCapability('forget', args, msg, config, td);
    await handleCeremonyOrSend(r, platform, msg, config, td, {
      capName: 'forget', args,
      echo: '⚠️ ERASE ALL notes AND this chat\'s history — this cannot be undone',
      format: (res) => `Cleared everything for this chat${res && res.removed ? ` (${res.removed} item(s))` : ''}.`,
    });
    return;
  }

  // /forget <topic> → blended keyword+semantic match on FACTS, then 0 / 1 / N flow.
  let matches;
  try { matches = await indexer.factCandidates(scope, q, { n: 8 }); }
  catch { matches = []; }

  // Relevance filter (semantic mode): recall's KNN ALWAYS returns a nearest neighbour, so an unrelated
  // topic ("unicorn") comes back with a low sim — without this, /forget unicorn would offer to delete a
  // random note. Keep a candidate only if it's a keyword hit (score>0) OR genuinely close (sim>=thresh).
  // Inert when sim is absent (BM25-only mode / tests): recall there is already keyword-precise (no KNN
  // noise), so nothing is filtered. Measured gap (installed litectx): spurious ≤0.17, legit ≥0.38.
  const forgetThreshold = config?.memory?.forget_match_threshold ?? 0.30;
  matches = matches.filter((m) => typeof m.sim !== 'number' || m.score > 0 || m.sim >= forgetThreshold);

  if (!matches.length) {
    const n = await noteCount();
    const have = (n != null && n > 0)
      ? ` You have ${n} note(s) — /memory to see them, or \`forget all\` to erase everything.`
      : ' You have no saved notes.';
    await platform.send(msg.chatId, `Nothing matches "${q}".${have}`);
    return;
  }

  // Per-match ceremony wording, shared by the 1-match and picker paths.
  const echoFor = (m) => `forget "${m.text}"`;
  const formatFor = (m) => (res) => (res && res.removed) ? `Forgotten: "${m.text}".` : `That note was already gone.`;

  // 1 match → straight to the ceremony (PIN prompt shows the note). Reuses the proven ceremony path,
  // which also handles the no-PIN config (executes immediately) and DENIED.
  if (matches.length === 1) {
    const m = matches[0];
    const args = { target: m.text, id: m.id };
    const r = await dispatchCapability('forget', args, msg, config, td);
    await handleCeremonyOrSend(r, platform, msg, config, td, { capName: 'forget', args, echo: echoFor(m), format: formatFor(m) });
    return;
  }

  // N matches → a read-only numbered picker (no PIN yet — listing destroys nothing). The pick chains
  // into the SAME per-note ceremony via the dispatcher's {next}, so there is exactly ONE ceremony.
  const list = matches.map((m, i) => `${i + 1}) ${m.text}`).join('\n');
  await platform.send(msg.chatId, `${matches.length} notes match "${q}" — reply with the number to forget (or "cancel"):\n${list}`);
  const ttlMs = (config?.security?.pin_prompt_timeout || 300) * 1000;
  const pickerAsk = {
    kind: 'picker',
    label: `forget "${q}"`,
    isOwner: isOwner(msg.senderId, config, msg),
    ttlMs,
    expireMsg: 'That forget prompt expired — re-send if you still want it.',
    stickHint: 'Reply with the number of the note to forget, or "cancel".',
    // showPrompt omitted — the numbered list is already sent → openAsk treats it as 'prompted'.
    accepts: (t) => { const s = t.trim(); const n = parseInt(s, 10); return /^\d+$/.test(s) && n >= 1 && n <= matches.length; },
    handle: async (t) => {
      const m = matches[parseInt(t.trim(), 10) - 1];
      const args = { target: m.text, id: m.id };
      const r = await dispatchCapability('forget', args, msg, config, td);
      if (r.kind === RESULT.NEEDS_CEREMONY) {
        // build the per-note ceremony ask (as handleCeremonyOrSend does) + show its PIN prompt, then
        // hand it to the dispatcher via {next} so the PIN reply resumes it.
        const bundle = gov ? await gov.resolve() : {};
        const ctx = buildGovernCtx(msg, config);
        const deps = buildSlashDeps(bundle, config, td);
        const ask = makeCeremonyAsk({
          capability: 'forget', args, ctx, deps, ceremonyPrompt: bundle.ceremonyPrompt,
          echo: echoFor(m), request: null, ttlMs,
          render: async (r2) => {
            if (r2.kind === RESULT.OK) { await platform.send(msg.chatId, 'PIN accepted.'); await platform.send(msg.chatId, formatFor(m)(r2.result)); }
            else await sendCapabilityResult(r2, platform, msg, {});
          },
        });
        const status = await ask.showPrompt();
        if (status !== 'prompted') {
          if (status === 'no-channel') await platform.send(msg.chatId, 'Could not prompt for the required PIN — action cancelled.');
          return { done: true, summary: 'forget — no PIN channel' }; // 'locked' already messaged in ceremonyPrompt
        }
        return { next: ask };
      }
      // no-PIN config (executed) or DENIED → render now, done.
      await sendCapabilityResult(r, platform, msg, { format: formatFor(m) });
      return { done: true, summary: 'forget (targeted)' };
    },
  };
  await openAsk(pickerAsk, { pending, chatId: msg.chatId, senderId: msg.senderId });
}

async function routeRemember(msg, platform, config, getMem, note, toolDeps = {}) {
  const r = await dispatchCapability('remember', { note: note || '' }, msg, config, { ...toolDeps, getMem });
  await sendCapabilityResult(r, platform, msg, {
    usage: 'Usage: /remember <note>',
    // Auto-update + tell-me: when the note overwrote a DIFFERENT prior value, show it so a wrong
    // overwrite is visible and recoverable (re-/remember it) — no confirm dialog. An identical
    // re-save (supersededText null) reads as a plain "Noted." (no misleading "was: <same>").
    format: (result) => (result?.supersededText
      ? `Noted — updated your earlier note (was: "${result.supersededText}").`
      : 'Noted.'),
  });
}

const VALID_MODES = ['off', 'business', 'silent'];

/**
 * Commit a resolved (chatId, mode) through the one governed core. set_mode is
 * benign for business/silent/personal but DESTRUCTIVE for `off` (the core's
 * destructiveWhen), so turning a chat off triggers the PIN ceremony here — the
 * single place every mode-set path funnels through (the four routeMode sites and
 * the picker-resume). On a declined ceremony / floor deny it renders that and
 * returns false; on success it assigns any agent and prints the confirmation.
 * The admin-gate, target resolution, and personal-chat block stay upstream as
 * pre-guards (the core doesn't model them).
 *
 * @returns {Promise<boolean>} true if the mode was committed.
 */
async function commitMode({ chatId, mode, agent, displayName }, msg, platform, config, toolDeps = {}) {
  const args = { target: chatId, mode };
  // The success tail runs identically whether set_mode cleared immediately
  // (silent/business → benign) or after the PIN ceremony (off → destructive,
  // park-and-resume). Sharing it keeps the agent-assignment + confirmation in one
  // place for both paths.
  const finish = async (res) => {
    if (res.kind !== RESULT.OK) {
      await sendCapabilityResult(res, platform, msg);
      return false;
    }
    if (agent) {
      if (!config.chat_agents) config.chat_agents = {};
      config.chat_agents[chatId] = agent;
      saveConfig(config);
    }
    const agentNote = agent ? `, agent: ${agent}` : '';
    await platform.send(msg.chatId, `${displayName || chatId} set to: ${mode}${agentNote}`);
    return true;
  };
  const r = await dispatchCapability('set_mode', args, msg, config, toolDeps);
  if (r.kind === RESULT.NEEDS_CEREMONY) {
    // `off` needs the PIN — prompt + park; finish runs on the reply, after this returns.
    // Friendly echo: the owner sees the chat's name, not its raw room id.
    await handleCeremonyOrSend(r, platform, msg, config, toolDeps, {
      capName: 'set_mode', args, onResume: finish, echo: `set "${displayName || chatId}" to ${mode}`,
    });
    return false; // pending — not yet committed
  }
  return finish(r);
}

// The mode picker (multiple chats match a /mode target) as an owner-ask (M10):
// single-shot numeric over `matches`. handle() commits the chosen chat via
// commitMode — which may itself open a PIN ceremony ask for an `off` set (the
// dispatcher already cleared this picker, so the new ceremony parks cleanly).
// An out-of-range number re-prompts (stays parked); commandCancels preserves the
// "issue another /command to abandon the picker" escape.
function makeModeAsk({ mode, matches, agent, msg, platform, config, toolDeps }) {
  const { platformRegistry } = toolDeps;
  return {
    kind: 'mode',
    request: null, // a picker is not conversation — record nothing
    isOwner: true,
    commandCancels: true,
    cancelMsg: 'Mode selection cancelled.',
    ttlMs: pickerTtlMs(config),
    expireMsg: 'Mode selection expired — re-run /mode.',
    stickMsg: `Pick a number (1-${matches.length}) or send a /command to cancel.`,
    accepts: (text) => /^\d+$/.test(text),
    handle: async (t) => {
      const idx = parseInt(t, 10) - 1;
      if (idx < 0 || idx >= matches.length) {
        await platform.send(msg.chatId, `Invalid choice. Pick 1-${matches.length}.`);
        return { retry: true }; // stay parked; owner picks again
      }
      const chat = matches[idx];
      const beeperPlat = platformRegistry?.get('beeper');
      if ((mode === 'silent' || mode === 'off') && beeperPlat?._personalChats?.has(chat.id)) {
        await platform.send(msg.chatId, 'Personal/note-to-self chats cannot be set to silent or off.');
        return { done: true }; // consumed; nothing set
      }
      await commitMode(
        { chatId: chat.id, mode, agent, displayName: chat.title || chat.id },
        msg, platform, config, toolDeps,
      );
      return { done: true };
    },
  };
}

async function routeMode(msg, platform, config, args, agentRegistry, toolDeps = {}) {
  const { platformRegistry, pending } = toolDeps;
  // Owner-only command.
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only command.');
    return;
  }

  const parts = (args || '').trim().split(/\s+/);
  const mode = parts[0] ? parts[0].toLowerCase() : '';

  // Telegram: /mode works as admin — can set per-chat Beeper modes via platform registry
  if (msg.platform === 'telegram') {
    const beeperPlatform = platformRegistry?.get('beeper');
    const hasBeeperChats = beeperPlatform && config.platforms?.beeper?.enabled;

    if (!mode) {
      let statusMsg = `Bot mode: ${roleLabel(config.bot_mode)}`;
      if (hasBeeperChats) {
        const allChats = await listBeeperChats(beeperPlatform, config);
        if (allChats && allChats.length > 0) {
          statusMsg += `\n\n${formatChatOverview(allChats, config)}`;
        }
      }
      statusMsg += `\n\n${MODE_FOOTER}`;
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
        const labels = disambiguateTitles(match, config);
        const list = match.map((c, i) => `  ${i + 1}) ${labels.get(c.id)}`).join('\n');
        await platform.send(msg.chatId, `Multiple matches:\n${list}\n\nReply with a number:`);
        await openAsk(makeModeAsk({ mode, matches: match, agent: null, msg, platform, config, toolDeps }),
          { pending, chatId: msg.chatId, senderId: msg.senderId });
        return;
      }
      const chat = match[0];
      // Block silent/off for personal/note-to-self chats
      if ((mode === 'silent' || mode === 'off') && beeperPlatform?._personalChats?.has(chat.id)) {
        await platform.send(msg.chatId, 'Personal/note-to-self chats cannot be set to silent or off.');
        return;
      }
      await commitMode({ chatId: chat.id, mode, displayName: chat.title || chat.id }, msg, platform, config, toolDeps);
      return;
    }

    // No target + business → show business menu
    if (mode === 'business') {
      await showBusinessMenu(msg, platform, config, { toolDeps });
      return;
    }

    // Global "off" is not supported. To halt the bot, stop the daemon
    // (`multis stop`) — a global off would keep the process running but playing
    // dead, with no way to re-enable from chat (off ignores incoming messages).
    // Per-chat off (/mode off <chat>) mutes a single conversation and IS supported.
    if (mode === 'off') {
      await platform.send(msg.chatId,
        'Global "off" isn\'t supported — to stop the bot, run `multis stop`.\n' +
        'To mute one chat: /mode off <chat name>.');
      return;
    }

    // No target → change the global role. bot_mode is a ROLE (§3g), so store the
    // canonical role, not the raw chat-mode word (only 'silent' reaches here —
    // 'business' shows the menu, 'off' is blocked above). silent → personal-assistant.
    config.bot_mode = normalizeRole(mode);
    saveConfig(config);
    await platform.send(msg.chatId, `Bot mode set to: ${roleLabel(config.bot_mode)}`);
    logAudit({ action: 'mode', user_id: msg.senderId, mode: config.bot_mode, scope: 'global' });
    return;
  }

  // Beeper: no args → list chats with current modes (read-only, no PIN needed)
  if (!mode) {
    if (config?.chats || typeof platform?.listInbox === 'function') {
      const allChats = await listBeeperChats(platform, config);
      if (!allChats || allChats.length === 0) {
        await platform.send(msg.chatId, 'No chats found.');
        return;
      }
      await platform.send(msg.chatId, `${formatChatOverview(allChats, config)}\n\n${MODE_FOOTER}`);
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

  // (Agent assignment to the resolved target now happens inside commitMode.)

  // Beeper: if target specified, search for chat by name/number
  if (target) {
    const match = await findBeeperChat(platform, target, config);
    if (!match) {
      await platform.send(msg.chatId, `No chat found matching "${target}".`);
      return;
    }
    if (match.length > 1) {
      const labels = disambiguateTitles(match, config);
      const list = match.map((c, i) => `  ${i + 1}) ${labels.get(c.id)}`).join('\n');
      await platform.send(msg.chatId, `Multiple matches:\n${list}\n\nReply with a number:`);
      await openAsk(makeModeAsk({ mode, matches: match, agent: agentArg, msg, platform, config, toolDeps }),
        { pending, chatId: msg.chatId, senderId: msg.senderId });
      return;
    }
    const chat = match[0];
    // Block silent/off for personal/note-to-self chats
    if ((mode === 'silent' || mode === 'off') && platform._personalChats?.has(chat.id)) {
      await platform.send(msg.chatId, 'Personal/note-to-self chats cannot be set to silent or off.');
      return;
    }
    await commitMode({ chatId: chat.id, mode, agent: agentArg, displayName: chat.title || chat.id }, msg, platform, config, toolDeps);
    return;
  }

  // Beeper: no target + business → show business menu
  if (mode === 'business' && msg.isSelf) {
    await showBusinessMenu(msg, platform, config, { toolDeps });
    return;
  }

  // Beeper: no target — if in self-chat, show interactive picker
  if (msg.isSelf) {
    const allChats = await listBeeperChats(platform, config);
    if (!allChats || allChats.length === 0) {
      await platform.send(msg.chatId, 'No chats found.');
      return;
    }
    // Exclude the current chat (command channel) from the picker
    const chats = allChats.filter(c => c.id !== msg.chatId);
    const labels = disambiguateTitles(chats, config);
    const list = chats.map((c, i) => {
      const currentMode = getChatMode(config, c.id);
      return `  ${i + 1}) ${labels.get(c.id)} [${currentMode}]`;
    }).join('\n');
    await platform.send(msg.chatId, `Pick a chat to set to ${mode}:\n${list}\n\nReply with a number:`);
    await openAsk(makeModeAsk({ mode, matches: chats, agent: agentArg, msg, platform, config, toolDeps }),
      { pending, chatId: msg.chatId, senderId: msg.senderId });
    return;
  }

  // Beeper: no target, not self-chat — set current chat
  await commitMode({ chatId: msg.chatId, mode, agent: agentArg, displayName: 'Chat mode' }, msg, platform, config, toolDeps);
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
  // Default mode for a non-owner chat is derived from the owner's role (§3g):
  // business→business, personal-assistant(+legacy 'personal')→silent, personal-bot→off.
  return defaultModeForRole(config.bot_mode);
}

/**
 * List chats from config.chats (filter by platform=beeper), sorted by lastActive desc.
 * No Beeper API call needed — works even when Desktop is down.
 */
async function listBeeperChats(platform, config) {
  // beeperbox's live inbox is the source of truth for what chats exist — it's
  // always current. Ask it first (recency-ordered); config.chats only overlays the
  // mode decisions + names for chats already acted on. If beeperbox is unreachable
  // we degrade to the configured chats so the menu still works offline.
  const botChatId = platform?._botChatId || null;
  const byId = new Map();

  if (typeof platform?.listInbox === 'function') {
    try {
      const live = await platform.listInbox(100);
      for (const c of live) {
        const id = c.id || c.chatID;
        if (!id || id === botChatId) continue;
        byId.set(id, { id, title: c.title || c.name || '', network: c.network || '' });
      }
    } catch { /* beeperbox unreachable → fall back to configured chats below */ }
  }

  // Merge in configured beeper chats not in the live window — one that fell out of
  // the recent ~24 but still has a mode set stays visible with its mode.
  if (config?.chats) {
    for (const [id, c] of Object.entries(config.chats)) {
      if (c.platform !== 'beeper' || id === botChatId || byId.has(id)) continue;
      byId.set(id, { id, title: c.name || '', network: c.network || '' });
    }
  }

  return [...byId.values()];
}

/**
 * Same-titled chats (e.g. two WhatsApp rooms for one contact) are
 * indistinguishable in a numbered picker — you can set a mode on the wrong room
 * and get a SILENT no-op (the change lands on a different room than the one
 * receiving messages, with no error). For colliding titles only, append the
 * last-active date so you can tell which numbered entry is the live one; you
 * still select by number. Returns id -> display label.
 */
function disambiguateTitles(chats, config) {
  const baseTitle = (c) => c.title || c.name || c.id;
  const counts = new Map();
  for (const c of chats) counts.set(baseTitle(c), (counts.get(baseTitle(c)) || 0) + 1);
  const labels = new Map();
  for (const c of chats) {
    const t = baseTitle(c);
    if (counts.get(t) === 1) { labels.set(c.id, t); continue; }
    const last = config.chats?.[c.id]?.lastActive;
    const d = last ? new Date(last) : null;
    // Guard a malformed/corrupted lastActive — new Date('garbage').toISOString()
    // throws, and this runs inside the picker render (would crash the list).
    const when = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : 'no activity';
    labels.set(c.id, `${t} · active ${when}`);
  }
  return labels;
}

// Shown under the read-only `/mode` overview — the teachable moment (you typed
// /mode to look; here's how to act). The overview is NOT a numbered picker: a
// number reply there isn't captured (it falls through to the agent), so it must
// not LOOK selectable. To act you use one of these forms.
const MODE_FOOTER =
  'Change a chat:\n' +
  ' /mode silent <name>   — set one by name\n' +
  ' /mode silent          — pick from a list\n' +
  'modes: business · silent · off';

/**
 * Read-only `/mode` overview body. Leads with the chats the bot is actually
 * engaging (business/silent) and collapses the off ones to a count — a 40-row
 * dump of mostly-off chats is noise, not status. De-numbered on purpose (the
 * overview is not a picker; browse/act via `/mode <mode>` or `… <name>`).
 */
function formatChatOverview(allChats, config) {
  const labels = disambiguateTitles(allChats, config);
  const withMode = allChats.map((c) => ({ c, mode: getChatMode(config, c.id) }));
  const engaged = withMode.filter((x) => x.mode !== 'off');
  const offCount = withMode.length - engaged.length;
  if (engaged.length === 0) return `No chats engaged (all ${withMode.length} off).`;
  let body = 'Engaged chats:\n' + engaged.map((x) => ` – ${labels.get(x.c.id)} — ${x.mode}`).join('\n');
  if (offCount > 0) body += `\n (${offCount} other${offCount !== 1 ? 's' : ''}: off)`;
  return body;
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
    const botChatId = platform._botChatId || null;
    const list = await platform.listInbox(100);
    const chats = list.map(c => ({
      id: c.id || c.chatID,
      title: c.title || c.name || '',
      network: c.network || '',
    })).filter(c => c.id && c.id !== botChatId);

    const matches = chats.filter(c =>
      (c.title && c.title.toLowerCase().includes(q)) ||
      (c.id && c.id.toLowerCase().includes(q))
    );
    if (matches.length === 0) return null; // no-upsert-on-failed-match

    // Persist ONLY the matched chats — never the whole recent-inbox window. The
    // old bulk upsert dumped all ~24 chats list_inbox returns into config.chats on
    // every name lookup, so config grew unevenly each time the window shifted
    // (25→35→43). We still persist the matched chat(s) because setChatMode stores
    // only {mode}, so the name/network must come from here for the chat to show in
    // the menu and be findable by name later. beeperbox stays the live directory;
    // config.chats is just the mode overlay + names for chats you've acted on.
    if (config) {
      if (!config.chats) config.chats = {};
      let changed = false;
      for (const c of matches) {
        if (!config.chats[c.id]) {
          config.chats[c.id] = { name: c.title, network: c.network, platform: 'beeper', lastActive: new Date().toISOString() };
          changed = true;
        }
      }
      if (changed) { backupConfig(); saveConfig(config); }
    }
    return matches;
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
      // Agentic jobs run as owner, so recall is scoped to 'admin' (admin ∪ global-KB)
      // — identical to the owner's interactive /ask. recall() is fail-closed and never
      // crosses into customer (user:*) scopes, even for an owner-run job.
      const memHits = indexer ? await indexer.recallMemory(job.action, { scope: 'admin', n: 5 }) : [];
      const memoryMd = memHits.map((h) => `- ${h.content}`).join('\n');
      const chunks = indexer ? await indexer.search(job.action, { scope: 'admin', n: 5 }) : [];
      const system = buildMemorySystemPrompt(memoryMd, chunks);

      const answer = await runAgentLoop(provider, [{ role: 'user', content: job.action }], userTools, {
        system,
        ctx: { senderId: config.owner_id, chatId: job.chatId, isOwner: admin, runtimePlatform, indexer, provider, memoryManager: mem, platform, platformName: job.platformName, config, platformRegistry },
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

async function showBusinessMenu(msg, platform, config, deps = {}) {
  const { toolDeps = {} } = deps;
  await platform.send(msg.chatId,
    'Business Mode\n' +
    '1) Setup persona\n' +
    '2) Show persona\n' +
    '3) Clear persona\n' +
    '4) Set as global default\n' +
    '5) Assign chats\n\n' +
    'Reply with a number:'
  );
  await openAsk(
    makeBusinessMenuAsk({ msg, platform, config, platformRegistry: toolDeps.platformRegistry, toolDeps }),
    { pending: toolDeps.pending, chatId: msg.chatId, senderId: msg.senderId },
  );
}

// The business menu (1-5) as an owner-ask (M10): single-shot numeric. Choices 1
// and 5 launch sub-asks (the setup wizard / the mode picker) on the SAME
// dispatcher — the dispatcher cleared this menu before handle ran, so each
// openAsk parks its successor cleanly.
function makeBusinessMenuAsk({ msg, platform, config, platformRegistry, toolDeps }) {
  return {
    kind: 'business_menu',
    request: null, isOwner: true, commandCancels: true,
    cancelMsg: 'Business menu cancelled.',
    ttlMs: pickerTtlMs(config),
    expireMsg: 'Business menu expired — re-run /mode business.',
    stickMsg: 'Pick 1-5 or send a /command to cancel.',
    accepts: (text) => /^[1-5]$/.test(text),
    handle: async (t) => {
      await runBusinessMenuChoice(parseInt(t, 10), msg, platform, config, platformRegistry, toolDeps);
      return { done: true };
    },
  };
}

async function runBusinessMenuChoice(choice, msg, platform, config, platformRegistry, toolDeps) {
  switch (choice) {
    case 1: {
      // Launch the setup wizard — pre-populated from existing config; parks on the
      // same (chat,sender) key for the multi-step fill.
      const existing = config.business || {};
      const state = {
        step: 'name',
        data: {
          name: existing.name || null,
          greeting: existing.greeting || null,
          topics: existing.topics ? existing.topics.map(t => ({ ...t })) : [],
          rules: existing.rules ? [...existing.rules] : [],
        },
      };
      const current = existing.name ? `\nCurrent: ${existing.name}` : '';
      await platform.send(msg.chatId, `Step 1/5 — Name${current}\nSend new name or "skip" to keep it.`);
      await openAsk(makeBusinessWizardAsk({ msg, platform, config, state }),
        { pending: toolDeps.pending, chatId: msg.chatId, senderId: msg.senderId });
      return;
    }
    case 2: {
      // Show persona
      const b = config.business || {};
      if (!b.name) {
        await platform.send(msg.chatId, 'No business persona configured. Use /mode business → 1 to set one up.');
        return;
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
      return;
    }
    case 3: {
      // Clear persona
      config.business = { ...config.business, name: null, greeting: null, topics: [], rules: [] };
      saveConfig(config);
      await platform.send(msg.chatId, 'Business persona cleared.');
      logAudit({ action: 'business_clear', user_id: msg.senderId });
      return;
    }
    case 4: {
      // Set as global default
      config.bot_mode = 'business';
      saveConfig(config);
      await platform.send(msg.chatId, 'Bot mode set to: business');
      logAudit({ action: 'mode', user_id: msg.senderId, mode: 'business', scope: 'global' });
      return;
    }
    case 5: {
      // Assign chats — delegate to the mode picker (another owner-ask).
      const beeperPlatform = platformRegistry?.get('beeper');
      const hasBeeperChats = beeperPlatform && config.platforms?.beeper?.enabled;
      if (!hasBeeperChats) {
        await platform.send(msg.chatId, 'No Beeper chats available. Connect Beeper first.');
        return;
      }
      const allChats = await listBeeperChats(beeperPlatform, config);
      if (!allChats || allChats.length === 0) {
        await platform.send(msg.chatId, 'No chats found.');
        return;
      }
      const chats = allChats.filter(c => c.id !== msg.chatId);
      const labels = disambiguateTitles(chats, config);
      const list = chats.map((c, i) => {
        const currentMode = getChatMode(config, c.id);
        return `  ${i + 1}) ${labels.get(c.id)} [${currentMode}]`;
      }).join('\n');
      await platform.send(msg.chatId, `Pick a chat to set to business:\n${list}\n\nReply with a number:`);
      await openAsk(makeModeAsk({ mode: 'business', matches: chats, agent: null, msg, platform, config, toolDeps }),
        { pending: toolDeps.pending, chatId: msg.chatId, senderId: msg.senderId });
      return;
    }
  }
}

// The business setup wizard as a multi-step owner-ask (M10): one ask whose mutable
// `state` ({ step, data }) advances per reply. handle runs ONE step and returns
// { next: self } to stay parked, or { done } when the confirm step ends it. cancel
// is owned by the dispatcher (CANCEL_RE → "Business setup cancelled.").
function makeBusinessWizardAsk({ msg, platform, config, state }) {
  const ask = {
    kind: 'business_wizard',
    request: null, isOwner: true, commandCancels: true,
    cancelMsg: 'Business setup cancelled.',
    ttlMs: wizardTtlMs(config),
    expireMsg: 'Business setup expired — re-run /mode business → 1.',
    accepts: () => true, // any non-cancel input is a step answer
    handle: async (input) => {
      const finished = await runBusinessWizardStep(input, state, msg, platform, config);
      return finished ? { done: true } : { next: ask };
    },
  };
  return ask;
}

// Run one wizard step against the mutable `state` ({ step, data }). Returns true
// when the wizard is finished (the confirm step), else false (advance + re-park).
// Cancel is handled upstream by the dispatcher, so it never reaches here.
async function runBusinessWizardStep(input, state, msg, platform, config) {
  const pending = state;
  const lower = input.toLowerCase();

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
      // The dispatcher already intercepts "no" (CANCEL_RE) → "Business setup
      // cancelled." A "yes" saves; any other stray reply discards. Either way the
      // confirm step ENDS the wizard (the dispatcher clears it on { done }).
      if (lower === 'yes' || lower === 'y') {
        config.business = { ...config.business, ...pending.data };
        saveConfig(config);
        await platform.send(msg.chatId, 'Business persona saved.');
        logAudit({ action: 'business_setup', user_id: msg.senderId, name: pending.data.name });
      } else {
        await platform.send(msg.chatId, 'Discarded.');
      }
      return true; // confirm always ends the wizard
  }
  return false; // any other step advanced state → re-park and continue
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

// Command catalogue — the single source for /help. Grouped by INTENT (not an
// alphabetical wall), role-filtered, deduped (/mode is one entry; its business
// menu is reached via `/mode business`). `role` gates visibility: 'all' (anyone
// who can run commands) or 'owner' (owner only).
const HELP_GROUPS = [
  { key: 'ASK',      tagline: 'find answers' },
  { key: 'REMEMBER', tagline: 'build memory & knowledge' },
  { key: 'SCHEDULE', tagline: 'do things later' },
  { key: 'RUN',      tagline: 'act on this machine' },
  { key: 'MANAGE',   tagline: 'configure the bot' },
];

const HELP_COMMANDS = [
  // ASK
  { name: 'ask',      group: 'ASK',      role: 'all',   usage: '/ask <question>',                 summary: 'ask about your documents & chats (or just type)' },
  { name: 'search',   group: 'ASK',      role: 'all',   usage: '/search <query>',                 summary: 'keyword-search the index' },
  { name: 'docs',     group: 'ASK',      role: 'all',   usage: '/docs',                           summary: 'show what is indexed' },
  { name: 'skills',   group: 'ASK',      role: 'all',   usage: '/skills',                         summary: 'list available skills' },
  // REMEMBER
  { name: 'remember', group: 'REMEMBER', role: 'all',   usage: '/remember <note>',                summary: 'save a note to memory' },
  { name: 'memory',   group: 'REMEMBER', role: 'all',   usage: '/memory',                         summary: 'show what I remember here' },
  { name: 'forget',   group: 'REMEMBER', role: 'all',   usage: '/forget <topic> | /forget all',    summary: 'remove specific notes (or everything)' },
  { name: 'index',    group: 'REMEMBER', role: 'owner', usage: '/index <path> <public|admin>',    summary: 'add a document to the knowledge base',
    detail: 'Adds a file to the searchable KB. Scope: public (everyone) or admin (owner-only knowledge — owner only). On Telegram/Beeper you can also just send a file to index it.' },
  // SCHEDULE
  { name: 'remind',   group: 'SCHEDULE', role: 'owner', usage: '/remind <when> <action> [--agent]', summary: 'set a one-off reminder' },
  { name: 'cron',     group: 'SCHEDULE', role: 'owner', usage: '/cron <expr> <action> [--agent]', summary: 'recurring scheduled task' },
  { name: 'jobs',     group: 'SCHEDULE', role: 'owner', usage: '/jobs',                           summary: 'list active scheduled jobs' },
  { name: 'cancel',   group: 'SCHEDULE', role: 'owner', usage: '/cancel <id>',                    summary: 'cancel a scheduled job' },
  // RUN
  { name: 'exec',     group: 'RUN',      role: 'owner', usage: '/exec <command>',                 summary: 'run a shell command (may need PIN)' },
  { name: 'read',     group: 'RUN',      role: 'owner', usage: '/read <path>',                    summary: 'read a file or directory (may need PIN)' },
  { name: 'plan',     group: 'RUN',      role: 'owner', usage: '/plan <goal>',                    summary: 'break a goal into steps & run them' },
  // MANAGE
  { name: 'mode',     group: 'MANAGE',   role: 'owner', usage: '/mode [business|silent|off] [chat]', summary: 'how I respond in a chat',
    detail: 'Bare `/mode` → a read-only overview of which chats are engaged, plus how to change one (it is not a picker — to act you give a mode). `/mode <mode>` → pick a chat from a list. `/mode <mode> <name>` → set that Beeper chat directly (picker on multiple matches). `/mode business` opens the business-persona menu. silent = archive only; off = ignore.' },
  { name: 'agent',    group: 'MANAGE',   role: 'owner', usage: '/agent [name]',                   summary: "show or set this chat's agent" },
  { name: 'agents',   group: 'MANAGE',   role: 'owner', usage: '/agents',                         summary: 'list all agents' },
  { name: 'pin',      group: 'MANAGE',   role: 'owner', usage: '/pin',                            summary: 'set or change your PIN' },
  { name: 'status',   group: 'MANAGE',   role: 'all',   usage: '/status',                         summary: 'bot info & status' },
  { name: 'help',     group: 'MANAGE',   role: 'all',   usage: '/help [command]',                 summary: 'this menu — add a command for details' },
];

const ROLE_RANK = { all: 0, owner: 1 };

/** The viewer's tier, highest first: owner > all. */
function helpViewerRank(msg, config) {
  if (isOwner(msg.senderId, config, msg)) return ROLE_RANK.owner;
  return ROLE_RANK.all;
}

async function routeHelp(msg, platform, config, args) {
  const rank = helpViewerRank(msg, config);
  const visible = HELP_COMMANDS.filter(c => rank >= ROLE_RANK[c.role]);

  // Progressive disclosure: `/help <command>` → that command's detail.
  const topic = (args || '').trim().replace(/^\//, '').toLowerCase();
  if (topic) {
    const c = visible.find(x => x.name === topic);
    if (c) {
      const lines = [c.usage, '', c.summary];
      if (c.detail) lines.push('', c.detail);
      await platform.send(msg.chatId, lines.join('\n'));
      return;
    }
    // Unknown/!visible topic falls through to the full menu (with a nudge).
  }

  const out = ['multis — what can I do?'];
  for (const g of HELP_GROUPS) {
    const cmds = visible.filter(c => c.group === g.key);
    if (cmds.length === 0) continue;
    out.push('', `${g.key} · ${g.tagline}`);
    for (const c of cmds) out.push(`  ${c.usage} — ${c.summary}`);
    // Owner-only inline hint: dropping a file is the no-typing path to /index.
    if (g.key === 'REMEMBER' && rank >= ROLE_RANK.owner) {
      out.push('  (or send a file to index it)');
    }
  }
  out.push('', 'Tip: just type to ask · @agent for a specific agent · /help <command> for details');
  if (topic) out.unshift(`No command "/${topic}". Showing everything:`, '');
  await platform.send(msg.chatId, out.join('\n'));
}

// The Beeper file-index scope picker as an owner-ask (M10): single-shot 1/2/3.
// commandCancels preserves the prior escape (issue another command to abandon it).
function makeIndexAsk({ fileName, srcURL, platform, indexer, msg, config }) {
  return {
    kind: 'index',
    request: null, // a picker is not conversation — record nothing
    isOwner: true,
    commandCancels: true,
    ttlMs: pickerTtlMs(config),
    expireMsg: 'File index prompt expired — re-send the file.',
    stickMsg: 'Reply 1 (public), 2 (admin), or 3 (skip), or "cancel".',
    showPrompt: async () => {
      await platform.send(msg.chatId, `Got "${fileName}". Index as:\n1. Public (kb)\n2. Admin only\n3. Skip\nReply 1, 2, or 3.`);
      return 'prompted';
    },
    accepts: (text) => /^[123]$/.test(text),
    handle: async (t) => {
      if (t === '3') {
        await platform.send(msg.chatId, 'Skipped.');
        return { done: true };
      }
      const scope = t === '1' ? 'public' : 'admin';
      try {
        await platform.send(msg.chatId, `Downloading and indexing: ${fileName} (${scope})...`);
        const buffer = await platform.downloadAsset(srcURL);
        const res = await indexer.indexBuffer(buffer, fileName, scope);
        await platform.send(msg.chatId, indexOutcomeMsg(res, fileName, scope));
        logAudit({ action: 'index_upload', user_id: msg.senderId, filename: fileName, chunks: res.chunks, scope, platform: 'beeper' });
      } catch (err) {
        await platform.send(msg.chatId, `Index error: ${err.message}`);
      }
      return { done: true };
    },
  };
}

async function handleBeeperFileIndex(msg, platform, config, indexer, pending) {
  if (!isOwner(msg.senderId, config, msg)) {
    await platform.send(msg.chatId, 'Owner only. File indexing not available.');
    return;
  }

  const supported = config.documents?.allowedTypes || ['pdf', 'docx', 'md', 'txt'];
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
    // Ask for scope via the one dispatcher (prompt + park).
    await openAsk(makeIndexAsk({ fileName, srcURL, platform, indexer, msg, config }),
      { pending, platform, chatId: msg.chatId, senderId: msg.senderId });
    return;
  }

  try {
    await platform.send(msg.chatId, `Downloading and indexing: ${fileName} (${scope})...`);
    const buffer = await platform.downloadAsset(srcURL);
    const res = await indexer.indexBuffer(buffer, fileName, scope);
    await platform.send(msg.chatId, indexOutcomeMsg(res, fileName, scope));
    logAudit({ action: 'index_upload', user_id: msg.senderId, filename: fileName, chunks: res.chunks, scope, platform: 'beeper' });
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
  const supported = config.documents?.allowedTypes || ['pdf', 'docx', 'md', 'txt'];

  if (!supported.includes(ext)) {
    await platform.send(msg.chatId, `Unsupported file type: .${ext}\nSupported: ${supported.join(', ')}`);
    return;
  }

  try {
    await platform.send(msg.chatId, `Downloading and indexing: ${filename}...`);
    const fileLink = await msg._telegram.getFileLink(doc.file_id);
    const response = await fetch(fileLink.href);
    const buffer = Buffer.from(await response.arrayBuffer());

    const res = await indexer.indexBuffer(buffer, filename, 'kb');
    await platform.send(msg.chatId, indexOutcomeMsg(res, filename, 'kb'));
    logAudit({ action: 'index_upload', user_id: msg.senderId, filename, chunks: res.chunks });
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
  const supported = config.documents?.allowedTypes || ['pdf', 'docx', 'md', 'txt'];

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
      const res = await indexer.indexBuffer(buffer, filename, scope);
      logAudit({ action: 'silent_index', user_id: msg.senderId, filename, chunks: res.chunks, scope, platform: 'telegram' });
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
      const res = await indexer.indexBuffer(buffer, attachment.fileName, scope);
      logAudit({ action: 'silent_index', user_id: msg.senderId, filename: attachment.fileName, chunks: res.chunks, scope, platform: 'beeper' });
    } catch (err) {
      console.error(`Silent index error (beeper): ${err.message}`);
    }
  }
}

module.exports = {
  // Platform-agnostic
  createMessageRouter,
  createSchedulerTick,
  buildAgentRegistry,
  resolveAgent,
  clearAdminPauses,
  disambiguateTitles,
  formatChatOverview,
  isPaired
};
