const fs = require('fs');
const path = require('path');
const { PATHS } = require('../config');

/**
 * Log an action to the audit log (append-only, newline-delimited JSON)
 * @param {Object} entry - Audit log entry
 */
function logAudit(entry) {
  const auditPath = PATHS.auditLog();
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });

  const logEntry = {
    timestamp: new Date().toISOString(),
    ...entry
  };

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
