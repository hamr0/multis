/**
 * Tool registry — loads tools.json config, filters by platform + enabled,
 * builds LLM-ready tool schemas.
 */

const fs = require('fs');
const path = require('path');
const { getPlatform } = require('./platform');
const { TOOLS } = require('./definitions');
const { getMultisDir } = require('../config');

/**
 * Load tools.json from ~/.multis/tools.json.
 * Returns {} if not found (all tools use defaults).
 */
function loadToolsConfig() {
  const toolsPath = path.join(getMultisDir(), 'tools.json');
  if (!fs.existsSync(toolsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(toolsPath, 'utf8'));
  } catch {
    console.warn('Failed to parse tools.json, using defaults.');
    return {};
  }
}

/**
 * Build the filtered tool list for the current platform + config.
 * @param {Object} [toolsConfig] — override tools.json (for testing)
 * @param {string} [platformOverride] — override detected platform (for testing)
 * @returns {Array} — filtered tool definitions
 */
function buildToolRegistry(toolsConfig, platformOverride) {
  const config = toolsConfig || loadToolsConfig();
  const platform = platformOverride || getPlatform();
  const toolSettings = config.tools || {};

  return TOOLS.filter(tool => {
    // Platform filter
    if (!tool.platforms.includes(platform)) return false;

    // Config filter: enabled defaults to true if not in config
    const setting = toolSettings[tool.name];
    if (setting && setting.enabled === false) return false;

    return true;
  });
}

/**
 * Get tools available for a specific user (owner vs non-owner).
 * @param {Array} tools — from buildToolRegistry
 * @param {boolean} isOwner — whether the user is the owner
 * @param {Object} [toolsConfig] — tools.json config
 * @returns {Array} — tools this user can use
 */
function getToolsForUser(tools, isOwner, toolsConfig) {
  const config = toolsConfig || loadToolsConfig();
  const toolSettings = config.tools || {};

  return tools.filter(tool => {
    const setting = toolSettings[tool.name];
    // FORCE_OWNER_ONLY is a hard floor: these host-reaching tools can never be
    // granted to a non-owner, even by a stale ~/.multis/tools.json. Other tools
    // fall back to the tools.json setting, then the per-name default.
    const ownerOnly = FORCE_OWNER_ONLY.has(tool.name)
      || (setting?.owner_only ?? DEFAULT_OWNER_ONLY[tool.name] ?? false);
    if (ownerOnly && !isOwner) return false;
    return true;
  });
}

// Host-reaching tools that MUST stay owner-only regardless of tools.json. These
// can read/exfiltrate host state or drive the machine, and a customer is never a
// privileged principal (see security model). exec/read_file/grep_files/find_files
// are additionally hard-denied for non-owners at the bareguard gate (ownerCheck),
// so they don't need the floor here — but these five have no gate-level check, so
// the registry is their only boundary.
const FORCE_OWNER_ONLY = new Set([
  'send_file',
  'system_info',
  'open_url',
  'notify',
  'media_control',
]);

// Default owner_only settings (used when tools.json doesn't specify)
const DEFAULT_OWNER_ONLY = {
  exec: true,
  read_file: true,
  send_file: true,
  system_info: true,
  open_url: true,
  notify: true,
  media_control: true,
  clipboard: true,
  screenshot: true,
  phone_call: true,
  sms_send: true,
  sms_list: true,
  contacts: true,
  location: true,
  camera: true,
  wifi: true,
  brightness: true
};

module.exports = {
  loadToolsConfig,
  buildToolRegistry,
  getToolsForUser,
  DEFAULT_OWNER_ONLY,
  FORCE_OWNER_ONLY
};
