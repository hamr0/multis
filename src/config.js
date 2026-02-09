const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MULTIS_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.multis');
const CONFIG_PATH = path.join(MULTIS_DIR, 'config.json');
const GOVERNANCE_PATH = path.join(MULTIS_DIR, 'governance.json');

/**
 * Ensure ~/.multis directory exists with default config files
 */
function ensureMultisDir() {
  if (!fs.existsSync(MULTIS_DIR)) {
    fs.mkdirSync(MULTIS_DIR, { recursive: true });
  }

  // Copy default config if not present
  if (!fs.existsSync(CONFIG_PATH)) {
    const templateDir = path.join(__dirname, '..', '.multis-template');
    fs.copyFileSync(path.join(templateDir, 'config.json'), CONFIG_PATH);
  }

  // Copy default governance if not present
  if (!fs.existsSync(GOVERNANCE_PATH)) {
    const templateDir = path.join(__dirname, '..', '.multis-template');
    fs.copyFileSync(path.join(templateDir, 'governance.json'), GOVERNANCE_PATH);
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

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // .env overrides
  if (process.env.TELEGRAM_BOT_TOKEN) {
    config.telegram_bot_token = process.env.TELEGRAM_BOT_TOKEN;
  }
  if (process.env.PAIRING_CODE) {
    config.pairing_code = process.env.PAIRING_CODE;
  }
  if (process.env.LLM_PROVIDER) {
    config.llm.provider = process.env.LLM_PROVIDER;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    config.llm.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.OPENAI_API_KEY) {
    config.llm.apiKey = process.env.OPENAI_API_KEY;
  }
  if (process.env.LLM_MODEL) {
    config.llm.model = process.env.LLM_MODEL;
  }

  // Migrate: set first allowed user as owner if owner_id missing
  if (!config.owner_id && config.allowed_users && config.allowed_users.length > 0) {
    config.owner_id = config.allowed_users[0];
    saveConfig(config);
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Add a user ID to the allowed users list.
 * First paired user automatically becomes owner.
 */
function addAllowedUser(userId) {
  const config = loadConfig();
  if (!config.allowed_users.includes(userId)) {
    config.allowed_users.push(userId);
  }
  // First paired user becomes owner
  if (!config.owner_id) {
    config.owner_id = userId;
  }
  saveConfig(config);
  return config;
}

/**
 * Check if a user is the owner
 */
function isOwner(userId, config) {
  return config.owner_id === userId;
}

module.exports = {
  loadConfig,
  saveConfig,
  addAllowedUser,
  isOwner,
  generatePairingCode,
  ensureMultisDir,
  MULTIS_DIR,
  CONFIG_PATH
};
