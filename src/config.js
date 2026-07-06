const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// MULTIS_HOME env var overrides default ~/.multis (used by tests and multi-instance setups)
// Getter functions allow tests to override paths at runtime.
let _multisDir = null;
function getMultisDir() {
  return _multisDir || process.env.MULTIS_HOME || path.join(process.env.HOME || process.env.USERPROFILE, '.multis');
}
function setMultisDir(dir) { _multisDir = dir; }

// Centralized path getters — all code should use PATHS instead of hardcoding
const PATHS = {
  config:       () => path.join(getMultisDir(), 'config.json'),
  tools:        () => path.join(getMultisDir(), 'tools.json'),
  db:           () => path.join(getMultisDir(), 'data', 'documents.db'),
  memory:       () => path.join(getMultisDir(), 'data', 'memory', 'chats'),
  governance:   () => path.join(getMultisDir(), 'auth', 'governance.json'),
  pinSessions:  () => path.join(getMultisDir(), 'auth', 'pin_sessions.json'),
  auditLog:     () => path.join(getMultisDir(), 'logs', 'audit.log'),
  injectionLog: () => path.join(getMultisDir(), 'logs', 'injection.log'),
  daemonLog:    () => path.join(getMultisDir(), 'logs', 'daemon.log'),
  pid:          () => path.join(getMultisDir(), 'run', 'multis.pid'),
  beeperCursor: () => path.join(getMultisDir(), 'run', 'beeper-cursor.json'),
};

// Legacy constants — point to default location. Prefer PATHS for new code.
const MULTIS_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.multis');
const CONFIG_PATH = path.join(MULTIS_DIR, 'config.json');

/**
 * Migrate flat ~/.multis layout to organized subdirs.
 * Idempotent — skips files that don't exist at old paths or already exist at new paths.
 */
function migrateLegacy() {
  const dir = getMultisDir();

  // Create subdirs
  for (const sub of ['data', 'auth', 'logs', 'run']) {
    const subDir = path.join(dir, sub);
    if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });
  }

  // Move individual files: [oldRelative, newRelative]
  const moves = [
    ['documents.db',             'data/documents.db'],
    ['governance.json',          'auth/governance.json'],
    ['pin_sessions.json',        'auth/pin_sessions.json'],
    ['beeper-token.json',        'auth/beeper-token.json'],
    ['audit.log',                'logs/audit.log'],
    ['prompt_injection_audit.log', 'logs/injection.log'],
    ['daemon.log',               'logs/daemon.log'],
    ['multis.pid',               'run/multis.pid'],
  ];

  for (const [oldRel, newRel] of moves) {
    const oldPath = path.join(dir, oldRel);
    const newPath = path.join(dir, newRel);
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.renameSync(oldPath, newPath);
    }
  }

  // Move memory/ → data/memory/ (entire directory)
  const oldMemDir = path.join(dir, 'memory');
  const newMemDir = path.join(dir, 'data', 'memory');
  if (fs.existsSync(oldMemDir) && !fs.existsSync(newMemDir)) {
    fs.renameSync(oldMemDir, newMemDir);
  }
}

/**
 * Ensure ~/.multis directory exists with default config files and organized subdirs
 */
function ensureMultisDir() {
  const dir = getMultisDir();

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // ~/.multis holds secrets — config.json (PIN hash + LLM API key + bot/MCP
  // tokens), auth/, and logs/. Lock the tree to the owner (0700) so other local
  // users can't traverse in and read them. Idempotent repair of an existing
  // world-readable dir; best-effort (e.g. Windows).
  try { fs.chmodSync(dir, 0o700); } catch { /* best-effort */ }

  // Migrate flat layout to subdirs (idempotent)
  migrateLegacy();

  // Copy default config if not present
  const configPath = PATHS.config();
  if (!fs.existsSync(configPath)) {
    const templateDir = path.join(__dirname, '..', '.multis-template');
    fs.copyFileSync(path.join(templateDir, 'config.json'), configPath);
  }

  // Copy default governance if not present
  const govPath = PATHS.governance();
  if (!fs.existsSync(govPath)) {
    const templateDir = path.join(__dirname, '..', '.multis-template');
    fs.mkdirSync(path.dirname(govPath), { recursive: true });
    fs.copyFileSync(path.join(templateDir, 'governance.json'), govPath);
  }

  // Copy default tools config if not present
  const toolsPath = PATHS.tools();
  if (!fs.existsSync(toolsPath)) {
    const templateDir = path.join(__dirname, '..', '.multis-template');
    const toolsTemplate = path.join(templateDir, 'tools.json');
    if (fs.existsSync(toolsTemplate)) {
      fs.copyFileSync(toolsTemplate, toolsPath);
    }
  }
}

/**
 * The bot's own secret env vars — the single authority for "which environment
 * keys hold credentials". Consumers that must not leak them (exec child-env
 * scrub, audit-log redaction) import this list so the two enforcement points
 * can never drift. Add a new provider/token key here and both inherit it.
 */
const SECRET_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'MCP_AUTH_TOKEN'];

/**
 * Load .env file into process.env (simple key=value parser)
 */
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Generate a 6-character pairing code
 */
function generatePairingCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

/**
 * Load and merge configuration from ~/.multis/config.json and .env
 * .env values override config.json values
 */
function loadConfig() {
  loadEnv();
  ensureMultisDir();

  const configPath = PATHS.config();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Ensure platforms block exists
  if (!config.platforms) config.platforms = {};
  if (!config.platforms.telegram) config.platforms.telegram = { enabled: true };
  if (!config.platforms.beeper) config.platforms.beeper = { enabled: false };

  // .env fills gaps — config.json (set by init) is source of truth
  if (process.env.TELEGRAM_BOT_TOKEN && !config.telegram_bot_token) {
    config.telegram_bot_token = process.env.TELEGRAM_BOT_TOKEN;
  }
  if (process.env.PAIRING_CODE && !config.pairing_code) {
    config.pairing_code = process.env.PAIRING_CODE;
  }
  if (process.env.LLM_PROVIDER && !config.llm.provider) {
    config.llm.provider = process.env.LLM_PROVIDER;
  }
  // Set API key from env only if config.json doesn't have one
  if (!config.llm.apiKey) {
    const provider = config.llm.provider;
    if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      config.llm.apiKey = process.env.ANTHROPIC_API_KEY;
    } else if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      config.llm.apiKey = process.env.OPENAI_API_KEY;
    } else if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
      config.llm.apiKey = process.env.GEMINI_API_KEY;
    }
  }
  if (process.env.LLM_MODEL && !config.llm.model) {
    config.llm.model = process.env.LLM_MODEL;
  }

  // Merge defaults for security section
  if (!config.security) config.security = {};
  config.security = {
    pin_timeout_hours: 24,
    pin_lockout_minutes: 60,
    prompt_injection_detection: true,
    // Fail-closed on an unpriced LLM round: when max_cost_per_run is set, a round
    // bareguard can't price (unknown model / no rate-table entry) HALTS instead of
    // silently passing under the cap. No-op when no cost cap is set. (bareguard 0.9.0)
    fail_closed_on_unpriced: true,
    rate_limit: { enabled: true, burst_per_min: 10, daily_per_sender: 100 },
    ...config.security
  };

  // Merge defaults for business section
  if (!config.business) config.business = {};
  config.business = {
    name: null,
    greeting: null,
    topics: [],
    rules: [],
    allowed_urls: [],
    ...config.business
  };
  if (!config.business.escalation) config.business.escalation = {};
  config.business.escalation = {
    escalate_keywords: ['refund', 'complaint', 'manager', 'supervisor', 'urgent', 'emergency'],
    admin_chat: config.business.admin_chat || null,
    admin_pause_minutes: 30,
    ...config.business.escalation
  };
  // Migrate legacy admin_chat to escalation sub-object
  if (config.business.admin_chat && !config.business.escalation.admin_chat) {
    config.business.escalation.admin_chat = config.business.admin_chat;
  }

  // M8: the assistant's name — the personal-mode trigger word AND the [Name] disclosure prefix on
  // contact-facing replies (§523). Default 'multis' so configs predating M8 always have a name.
  if (!config.assistant_name) config.assistant_name = 'multis';

  // Ensure config.chats block exists (single source of truth for chat metadata)
  if (!config.chats) config.chats = {};

  // Migrate chat_modes → config.chats (one-time, backward compatible)
  const oldModes = config.platforms?.beeper?.chat_modes;
  if (oldModes && typeof oldModes === 'object') {
    for (const [chatId, mode] of Object.entries(oldModes)) {
      if (!config.chats[chatId]) config.chats[chatId] = {};
      if (!config.chats[chatId].mode) config.chats[chatId].mode = mode;
    }
    delete config.platforms.beeper.chat_modes;
    saveConfig(config);
  }

  // M8 migration: pre-M8, `personal` in chats[].mode was a stale profile-rename artifact that
  // getChatMode IGNORED (it fell through to the role default) — it was never a settable mode.
  // M8 makes `personal` a real rung, so a stale `personal` would now be honored, silently
  // flipping a chat to respond-when-named. Remap ONLY a stale `personal` that the current role
  // can't use (business / personal-bot accounts) to that role's default; on a personal-assistant
  // account `personal` is the default rung, so it's kept. business/silent/off are deliberately
  // left alone — they behaved identically before and after M8, so retroactively re-scoping them
  // would CHANGE behavior, not preserve it (that full reconcile belongs only on a deliberate init
  // role switch, not on every load). Runs after the chat_modes migration so those are covered too.
  if (!allowedModesForRole(config.bot_mode).includes('personal')) {
    let migrated = 0;
    for (const chat of Object.values(config.chats)) {
      if (chat && chat.mode === 'personal') { chat.mode = defaultModeForRole(config.bot_mode); migrated++; }
    }
    if (migrated > 0) saveConfig(config);
  }

  // Merge defaults for memory section
  if (!config.memory) config.memory = {};
  config.memory = {
    enabled: true,
    recent_window: 20,
    // M4: durable memory is the litectx episode→fact ladder. promote_threshold = episode recalls
    // (within the episode window below) that auto-promote it to a durable fact. Facts are durable
    // until /forget. litectx owns decay/ranking (no ACT-R, no memory.md caps).
    promote_threshold: 10,
    // episode_window_days (litectx 0.25.0 episodeWindowDays) — ONE coupled window that is BOTH how long
    // an episode is retained AND how long it stays promote-eligible. Default 90: episodes (the
    // conversation thread + promotion fuel) live ~90 days, so a chat resumed after a gap keeps its
    // context; durable facts still persist via promotion regardless. NOTE the coupling: raising this
    // also lengthens the promotion window (more time to reach promote_threshold → more facts promote);
    // there is no "retain 90 but promote in 30" — they're one window. Must be > the promote-and-prove
    // time (litectx rejects ≤0); 30 is litectx's safe default, lower it only for data-minimization.
    episode_window_days: 90,
    log_retention_days: 30,
    // R4: semantic (KNN) recall — litectx blends BM25 + embeddings so a reworded question still
    // finds the fact (paraphrase recall), tenant-fence intact. Pulls @huggingface/transformers +
    // loads a small model (~2s once per process). Set false to stay BM25-only (no model, no dep load).
    semantic: true,
    // W4: same-subject supersession on /remember — before writing a new durable fact, an LLM judge
    // checks whether it RESTATES-AND-UPDATES an existing fact (changed deadline, corrected detail); if
    // so the new value overwrites that fact in place (litectx 0.24.0 tenant-fenced (scope,id) upsert)
    // instead of piling up a contradiction. Costs one extra LLM call per /remember (human-initiated,
    // low-frequency). false → always write a new fact (no judge). supersede_candidates = how many
    // most-relevant existing facts the judge weighs (scope-fenced, so a mis-judge only ever touches
    // this tenant's own memory). A judge error/uncertainty falls back to a new fact (never destroys).
    supersede: true,
    supersede_candidates: 5,
    // M13: cosine floor for the supersede pre-check. Before the judge runs, the closest existing fact's
    // semantic similarity to the new note is checked; below this → definitely a NEW subject → the LLM
    // judge is SKIPPED (it could only say NEW), saving a round-trip on the common "unrelated note" save.
    // Only active in semantic mode (needs the embedder). Conservative by design (broad POC: lowest real
    // restatement ~0.44, highest unrelated ~0.44 tails, bulk well-separated) — a false-skip writes a
    // duplicate, so bias LOW: too-low only costs saved calls, too-high risks a missed update. Decisions
    // are logged (audit action:'supersede_precheck') so the floor can be tuned on real saves.
    supersede_threshold: 0.30,
    // M14: cosine floor for a targeted `/forget <topic>` match. Semantic recall's KNN always returns a
    // nearest note, so an unrelated topic would otherwise offer to delete a random note; a candidate is
    // shown only if it's a keyword hit OR its similarity clears this. Measured gap (broad POC): spurious
    // topics ≤0.17, genuine ≥0.38 — 0.30 sits in the middle. Only active in semantic mode.
    forget_match_threshold: 0.30,
    // M5 context-engineering — token budget for the conversation window sent to the model each agent
    // round. litectx's `assemble` (via bare-agent's Loop hook) fits the running transcript to this many
    // tokens, recency-anchored: it always keeps the system prompt + the user's task (auto-pinned) and the
    // newest turns, never splits a tool-call/result pair, and drops OLDEST history first when a turn grows
    // past budget (e.g. a tool-heavy loop accumulating large results). Generous by design — a normal chat
    // (recent_window turns) is far under it, so assemble is a no-op until a turn actually balloons. Set 0
    // / null to disable (send full context, pre-M5 behavior). Fail-open: an assemble error sends full
    // context, never halts. Does NOT touch the relevance-ranked doc/memory injection (top-5, unbudgeted).
    // FLOOR (live-verified 2026-07-04): must comfortably exceed ONE turn's tool working set — up to
    // max_tool_rounds tool results, each ≤ MAX_OUTPUT(4000 chars ≈ 1000 tok) → ~5-6k here. Set it below
    // that and the model loses its own tool results mid-turn, keeps re-searching, and hits the round cap
    // (a silent "too many tool steps" halt). Default 24000 is generous on purpose: at current caps the
    // transcript tops out ~12-15k so it's a dormant safety net, and a LOW default would be a footgun.
    context_budget: 24000,
    ...config.memory
  };

  // Ensure a tool-round cap is always set so the bareguard gate bounds the
  // agent loop even for configs created before this knob existed (unbounded =
  // a runaway loop / cost amplifier).
  if (!config.llm) config.llm = {};
  if (config.llm.max_tool_rounds == null) config.llm.max_tool_rounds = 5;

  // Document parser limits — bound untrusted attachment input (file size, PDF
  // page count, parse wall-clock) to prevent OOM / decompression bombs.
  if (!config.documents) config.documents = {};
  config.documents = {
    maxSize: 10485760,
    maxPdfPages: 2000,
    parseTimeoutMs: 30000,
    allowedTypes: ['pdf', 'docx', 'txt', 'text', 'md', 'log', 'csv'],
    ...config.documents
  };

  // Interactive picker / wizard lifetimes. These bound how long an open prompt
  // (mode/index/admin picker, business menu, business setup wizard) stays live
  // before it expires and the router announces "re-send the command" instead of
  // letting a late numeric reply fall through to RAG. In-memory only — a pending
  // picker is intentionally dropped on restart. Quick numeric pickers get a short
  // window; the multi-step business wizard gets longer so a slow fill isn't lost.
  if (!config.interaction) config.interaction = {};
  config.interaction = {
    picker_ttl_minutes: 5,
    wizard_ttl_minutes: 30,
    ...config.interaction
  };

  // Migrate: set first allowed user as owner if owner_id missing
  if (!config.owner_id && config.allowed_users && config.allowed_users.length > 0) {
    config.owner_id = config.allowed_users[0];
    saveConfig(config);
  }

  // Backward compat: sync telegram_bot_token into platforms block
  if (config.telegram_bot_token && !config.platforms.telegram.bot_token) {
    config.platforms.telegram.bot_token = config.telegram_bot_token;
  }

  // Generate pairing code if not set
  if (!config.pairing_code) {
    config.pairing_code = generatePairingCode();
    saveConfig(config);
  }

  return config;
}

/**
 * Save config back to ~/.multis/config.json
 */
function saveConfig(config) {
  ensureMultisDir();
  const configPath = PATHS.config();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  // Holds the PIN hash, LLM API key, and bot/MCP tokens — owner-only. mode on
  // writeFileSync only applies on create, so chmod every save to repair an
  // existing 0644 file too. Best-effort (non-POSIX FS).
  try { fs.chmodSync(configPath, 0o600); } catch { /* best-effort */ }
}

/**
 * Backup config.json → config.json.bak before risky writes (e.g. Beeper API discovery).
 * Simple overwrite of previous backup.
 */
function backupConfig() {
  const configPath = PATHS.config();
  if (fs.existsSync(configPath)) {
    const backupPath = configPath + '.bak';
    fs.copyFileSync(configPath, backupPath);
    // The backup holds the same secrets (PIN hash, API key, tokens). copyFileSync
    // carries the source mode, but assert 0600 like saveConfig so the .bak can
    // never lag behind on perms. Best-effort (non-POSIX FS).
    try { fs.chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
  }
}

/**
 * Upsert chat metadata into config.chats[chatId].
 * Creates entry if missing, merges fields if exists, always updates lastActive.
 */
function updateChatMeta(config, chatId, fields) {
  if (!config.chats) config.chats = {};
  if (!config.chats[chatId]) config.chats[chatId] = {};
  Object.assign(config.chats[chatId], fields);
  config.chats[chatId].lastActive = new Date().toISOString();
  saveConfig(config);
}

/**
 * Add a user ID to the allowed users list.
 * First paired user automatically becomes owner.
 */
function addAllowedUser(userId) {
  const id = String(userId);
  const config = loadConfig();
  if (!config.allowed_users.map(String).includes(id)) {
    config.allowed_users.push(id);
  }
  // First paired user becomes owner
  if (!config.owner_id) {
    config.owner_id = id;
  }
  saveConfig(config);
  return config;
}

/**
 * Check if a user is the owner.
 * Accepts optional msg object — Beeper self-messages are always owner
 * (senderId is platform-specific, won't match Telegram owner_id).
 */
function isOwner(userId, config, msg) {
  // On Beeper the owner is identified by the account's own note-to-self chat —
  // `isSelf` AND `isPersonalChat`. Requiring the personal-chat signal (not bare
  // `isSelf`) keeps the owner grant from leaning solely on the transport flag:
  // a self-message in a random/silent chat no longer confers owner.
  // Defense-in-depth over the platform's own routing gate (PRD §11.1).
  // Telegram never sets isSelf → uses owner_id below.
  if (msg && msg.isSelf && msg.isPersonalChat) return true;
  return String(config.owner_id) === String(userId);
}

// ---------------------------------------------------------------------------
// Role ↔ mode (PRD §3g). `bot_mode` is the owner's choice of how the bot treats
// NON-owner chats by default — the owner is always served regardless. Three
// roles map to a default mode (M8 engagement ladder: business→business,
// personal-assistant→personal, personal-bot→off); the legacy 2-value `personal`
// is an alias for `personal-assistant`, so existing configs keep working with no
// migration (they inherit the new `personal` default rung).
// ---------------------------------------------------------------------------
const ROLES = {
  'business':           { label: 'Business chatbot',   mode: 'business' }, // auto-respond to contacts
  'personal-assistant': { label: 'Personal assistant', mode: 'personal' }, // M8: respond only when named; owner served fully
  'personal-bot':       { label: 'Personal bot',       mode: 'off' },      // ignore contacts; owner-only
};

/** Normalize a stored bot_mode to a canonical role key (legacy 'personal' → assistant). */
function normalizeRole(botMode) {
  if (botMode === 'business') return 'business';
  if (botMode === 'personal-bot') return 'personal-bot';
  return 'personal-assistant'; // 'personal-assistant', legacy 'personal', or unset
}

/** Default mode applied to a non-owner chat for the given role. */
function defaultModeForRole(botMode) {
  return ROLES[normalizeRole(botMode)].mode;
}

/**
 * M8 (§514) — the constrained per-chat `/mode` picker set for a role: the account's engaged rung
 * (first), then the step-downs `silent` and `off`. Deduped so `personal-bot` (default `off`) yields
 * `['off','silent']`. This is the anti-confusion rule — a chat can only step DOWN or back up to the
 * account default, never cross to another account's engaged style (a personal account can't set one
 * chat `business`, and vice-versa). Single-sourced here so the picker + its tests can't drift.
 */
function allowedModesForRole(botMode) {
  return [...new Set([defaultModeForRole(botMode), 'silent', 'off'])];
}

/**
 * M8 clean role switch: when the account changes role, remap any stored per-chat
 * mode that isn't valid for the NEW role to that role's default (engaged) mode.
 * `silent` and `off` are valid in every role (allowedModesForRole), so they're
 * never touched — only the OLD role's engaged mode (`business`/`personal`) is
 * invalid in the new role and gets re-expressed as the new engaged mode. This
 * preserves engagement intent across a switch (engaged↔engaged, muted stays
 * muted) and prevents stale cross-role modes bleeding through. Returns the count
 * of chats remapped (for the init log). Mutates config.chats in place.
 */
function reconcileChatModes(config, newRole) {
  const allowed = allowedModesForRole(newRole);
  const fallback = defaultModeForRole(newRole);
  let remapped = 0;
  for (const chat of Object.values(config.chats || {})) {
    if (chat && chat.mode && !allowed.includes(chat.mode)) {
      chat.mode = fallback;
      remapped++;
    }
  }
  return remapped;
}

/**
 * Init connect step, keep-token path (M8 fix): enable the bound Telegram transport.
 * `applyRoleTransport` only DISABLES the non-selected transport — enabling the selected one
 * is the connect step's job. When the user presses Enter to keep a verified token, that step
 * short-circuits, so without this it never enables Telegram: switching INTO personal-bot from
 * a Beeper role (where telegram.enabled was set false) leaves BOTH transports off → the daemon
 * refuses to start with "No platforms configured". Pure + exported so the wizard's keep-token
 * path is regression-testable without driving the interactive prompt. Mutates + returns config.
 */
function enableKeptTelegram(config, existingToken) {
  if (!config.platforms) config.platforms = {};
  if (!config.platforms.telegram) config.platforms.telegram = {};
  config.platforms.telegram.enabled = true;
  if (existingToken && !config.platforms.telegram.bot_token) config.platforms.telegram.bot_token = existingToken;
  return config;
}

/** Human label for a role (init/status/doctor display). */
function roleLabel(botMode) {
  return ROLES[normalizeRole(botMode)].label;
}

// Init Step 1 maps a menu choice to a role. Single-sourced here so the wizard
// (bin/multis.js) and its tests agree on the mapping.
const ROLE_BY_CHOICE = { '1': 'personal-bot', '2': 'personal-assistant', '3': 'business' };

/**
 * The transport bound 1:1 to a role (PRD §3g): personal-bot → Telegram (owner-
 * only); personal-assistant / business → Beeper (the only channel that can see
 * and respond to the owner's real contacts across networks).
 */
function transportForRole(botMode) {
  const useTelegram = normalizeRole(botMode) === 'personal-bot';
  return { useTelegram, useBeeper: !useTelegram };
}

/**
 * Apply a role to a config: canonicalize bot_mode and DISABLE the transport not
 * bound to this role (the 1:1 flip — switching role cleanly flips transport).
 * Enabling the bound transport is left to the connection step (it is network-
 * gated: Telegram needs a verified token, Beeper needs a reachable beeperbox).
 * Returns the binding so the caller can drive its connect branches.
 */
function applyRoleTransport(config, botMode) {
  const role = normalizeRole(botMode);
  config.bot_mode = role;
  if (!config.platforms) config.platforms = {};
  if (!config.platforms.telegram) config.platforms.telegram = {};
  if (!config.platforms.beeper) config.platforms.beeper = {};
  const { useTelegram, useBeeper } = transportForRole(role);
  if (!useTelegram) config.platforms.telegram.enabled = false;
  if (!useBeeper) config.platforms.beeper.enabled = false;
  return { useTelegram, useBeeper };
}

module.exports = {
  loadConfig,
  saveConfig,
  backupConfig,
  updateChatMeta,
  addAllowedUser,
  isOwner,
  normalizeRole,
  defaultModeForRole,
  allowedModesForRole,
  reconcileChatModes,
  enableKeptTelegram,
  roleLabel,
  ROLE_BY_CHOICE,
  transportForRole,
  applyRoleTransport,
  generatePairingCode,
  ensureMultisDir,
  getMultisDir,
  setMultisDir,
  SECRET_ENV_KEYS,
  PATHS,
  MULTIS_DIR,
  CONFIG_PATH
};
