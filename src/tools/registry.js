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
    // Default owner_only based on tool name for sensitive tools
    const ownerOnly = setting?.owner_only ?? DEFAULT_OWNER_ONLY[tool.name] ?? false;
    if (ownerOnly && !isOwner) return false;
    return true;
  });
}

// Default owner_only settings (used when tools.json doesn't specify)
const DEFAULT_OWNER_ONLY = {
  exec: true,
  read_file: true,
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

/**
 * Convert tool definitions to LLM-compatible tool schemas.
 * Works for Anthropic/OpenAI format.
 * @param {Array} tools — filtered tool list
 * @returns {Array} — [{name, description, input_schema}]
 */
function toLLMSchemas(tools) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema
  }));
}

module.exports = {
  loadToolsConfig,
  buildToolRegistry,
  getToolsForUser,
  toLLMSchemas,
  DEFAULT_OWNER_ONLY
};
