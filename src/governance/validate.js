const fs = require('fs');
const path = require('path');
const { PATHS } = require('../config');

/**
 * Load governance configuration
 * @returns {Object} Governance config
 */
function loadGovernance() {
  const configPath = PATHS.governance();

  if (!fs.existsSync(configPath)) {
    throw new Error('Governance config not found. Run: multis init');
  }

  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

/**
 * Check if a command is allowed by governance policy
 * @param {string} command - Full command string (e.g., "ls -la ~/Documents")
 * @returns {Object} - { allowed: boolean, reason?: string, requiresConfirmation: boolean }
 */
function isCommandAllowed(command, gov = null) {
  gov = gov || loadGovernance();
  const parts = command.trim().split(/\s+/);
  const baseCmd = parts[0];

  // Check denylist first (explicit deny wins)
  if (gov.commands.denylist.includes(baseCmd)) {
    return {
      allowed: false,
      reason: `Command '${baseCmd}' is explicitly denied by governance policy`,
      requiresConfirmation: false
    };
  }

  // Check if requires confirmation
  const needsConfirmation = gov.commands.requireConfirmation.includes(baseCmd);

  // Check allowlist
  if (gov.commands.allowlist.includes(baseCmd)) {
    return {
      allowed: true,
      requiresConfirmation: needsConfirmation
    };
  }

  // Not in allowlist = denied
  return {
    allowed: false,
    reason: `Command '${baseCmd}' is not in the allowlist`,
    requiresConfirmation: false
  };
}

/**
 * Check if a path is allowed by governance policy
 * @param {string} filePath - Path to check
 * @returns {Object} - { allowed: boolean, reason?: string }
 */
function isPathAllowed(filePath, gov = null) {
  gov = gov || loadGovernance();
  const expandedPath = filePath.replace(/^~/, process.env.HOME || process.env.USERPROFILE);

  // Check denied paths first
  for (const deniedPath of gov.paths.denied) {
    const expandedDenied = deniedPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE);
    if (expandedPath.startsWith(expandedDenied)) {
      return {
        allowed: false,
        reason: `Path '${filePath}' is in a denied directory`
      };
    }
  }

  // Check allowed paths
  for (const allowedPath of gov.paths.allowed) {
    const expandedAllowed = allowedPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE);
    if (expandedPath.startsWith(expandedAllowed)) {
      return { allowed: true };
    }
  }

  // Not in allowed paths = denied
  return {
    allowed: false,
    reason: `Path '${filePath}' is not in an allowed directory`
  };
}

module.exports = {
  loadGovernance,
  isCommandAllowed,
  isPathAllowed
};
