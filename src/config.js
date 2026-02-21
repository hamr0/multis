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
  beeperToken:  () => path.join(getMultisDir(), 'auth', 'beeper-token.json'),
  auditLog:     () => path.join(getMultisDir(), 'logs', 'audit.log'),
  injectionLog: () => path.join(getMultisDir(), 'logs', 'injection.log'),
  daemonLog:    () => path.join(getMultisDir(), 'logs', 'daemon.log'),
  pid:          () => path.join(getMultisDir(), 'run', 'multis.pid'),
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
    ...config.business.escalation
  };
  // Migrate legacy admin_chat to escalation sub-object
  if (config.business.admin_chat && !config.business.escalation.admin_chat) {
    config.business.escalation.admin_chat = config.business.admin_chat;
  }

  // Merge defaults for memory section
  if (!config.memory) config.memory = {};
  config.memory = {
    enabled: true,
    recent_window: 20,
    capture_threshold: 10,
    decay_rate: 0.05,
    memory_max_sections: 12,
    retention_days: 90,
    admin_retention_days: 365,
    log_retention_days: 30,
    ...config.memory
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
  if (msg && msg.isSelf) return true;
  return String(config.owner_id) === String(userId);
}

module.exports = {
  loadConfig,
  saveConfig,
  addAllowedUser,
  isOwner,
  generatePairingCode,
  ensureMultisDir,
  getMultisDir,
  setMultisDir,
  PATHS,
  MULTIS_DIR,
  CONFIG_PATH
};
