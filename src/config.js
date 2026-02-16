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

// Legacy constants — point to default location. Internal code should use getters.
const MULTIS_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.multis');
const CONFIG_PATH = path.join(MULTIS_DIR, 'config.json');
const GOVERNANCE_PATH = path.join(MULTIS_DIR, 'governance.json');

/**
 * Ensure ~/.multis directory exists with default config files
 */
function ensureMultisDir() {
  const dir = getMultisDir();
  const configPath = path.join(dir, 'config.json');
  const govPath = path.join(dir, 'governance.json');

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Copy default config if not present
  if (!fs.existsSync(configPath)) {
    const templateDir = path.join(__dirname, '..', '.multis-template');
    fs.copyFileSync(path.join(templateDir, 'config.json'), configPath);
  }

  // Copy default governance if not present
  if (!fs.existsSync(govPath)) {
    const templateDir = path.join(__dirname, '..', '.multis-template');
    fs.copyFileSync(path.join(templateDir, 'governance.json'), govPath);
  }

  // Copy default tools config if not present
  const toolsPath = path.join(dir, 'tools.json');
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

  const configPath = path.join(getMultisDir(), 'config.json');
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
  if (!config.business.escalation) config.business.escalation = {};
  config.business.escalation = {
    max_retries_before_escalate: 2,
    escalate_keywords: ['refund', 'complaint', 'manager', 'supervisor', 'urgent', 'emergency'],
    allowed_urls: [],
    ...config.business.escalation
  };

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
  const configPath = path.join(getMultisDir(), 'config.json');
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
  MULTIS_DIR,
  CONFIG_PATH
};
