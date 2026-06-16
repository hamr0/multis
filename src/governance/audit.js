const fs = require('fs');
const path = require('path');
const { PATHS } = require('../config');

// Audit entries can carry raw command/stderr strings (e.g. an /exec command the
// owner typed with an inline secret). Replace any KNOWN secret value — the bot's
// own credentials from the environment — with *** before it's persisted. Known
// values only: precise, no false positives, never mangles a legitimate command.
const SECRET_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'MCP_AUTH_TOKEN'];

function knownSecrets() {
  return SECRET_ENV_KEYS
    .map(k => process.env[k])
    .filter(v => typeof v === 'string' && v.length >= 8);
}

function redactSecrets(value, secrets) {
  if (!secrets.length) return value;
  if (typeof value === 'string') {
    let s = value;
    for (const sec of secrets) {
      if (s.includes(sec)) s = s.split(sec).join('***');
    }
    return s;
  }
  if (Array.isArray(value)) return value.map(v => redactSecrets(v, secrets));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactSecrets(value[k], secrets);
    return out;
  }
  return value;
}

/**
 * Log an action to the audit log (append-only, newline-delimited JSON)
 * @param {Object} entry - Audit log entry
 */
function logAudit(entry) {
  const auditPath = PATHS.auditLog();
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });

  const logEntry = redactSecrets({
    timestamp: new Date().toISOString(),
    ...entry
  }, knownSecrets());

  const line = JSON.stringify(logEntry) + '\n';

  // Append-only (creates file if doesn't exist)
  fs.appendFileSync(auditPath, line, 'utf8');
}

/**
 * Read recent audit logs
 * @param {number} limit - Number of recent entries to return
 * @returns {Array} - Recent audit log entries
 */
function readAuditLogs(limit = 100) {
  const auditPath = PATHS.auditLog();

  if (!fs.existsSync(auditPath)) {
    return [];
  }

  const content = fs.readFileSync(auditPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);

  // Parse last N lines
  const recentLines = lines.slice(-limit);
  return recentLines.map(line => JSON.parse(line));
}

/**
 * Get audit statistics
 * @returns {Object} - Statistics about audit logs
 */
function getAuditStats() {
  const logs = readAuditLogs(1000); // Last 1000 entries

  const stats = {
    total: logs.length,
    byUser: {},
    byCommand: {},
    denied: 0,
    confirmed: 0
  };

  logs.forEach(log => {
    // Count by user
    if (log.user_id) {
      stats.byUser[log.user_id] = (stats.byUser[log.user_id] || 0) + 1;
    }

    // Count by command
    if (log.command) {
      const baseCmd = log.command.split(' ')[0];
      stats.byCommand[baseCmd] = (stats.byCommand[baseCmd] || 0) + 1;
    }

    // Count denied
    if (log.allowed === false) {
      stats.denied++;
    }

    // Count confirmed
    if (log.confirmed === true) {
      stats.confirmed++;
    }
  });

  return stats;
}

module.exports = {
  logAudit,
  readAuditLogs,
  getAuditStats
};
