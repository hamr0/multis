const fs = require('fs');
const path = require('path');
const { PATHS } = require('../config');

/**
 * Delete daily log files older than maxDays across all chat directories.
 * @returns {{ deleted: number, errors: number }}
 */
function cleanupLogs(maxDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  let deleted = 0;
  let errors = 0;

  if (!fs.existsSync(PATHS.memory())) return { deleted, errors };

  const chatDirs = fs.readdirSync(PATHS.memory(), { withFileTypes: true });
  for (const dir of chatDirs) {
    if (!dir.isDirectory()) continue;
    const logDir = path.join(PATHS.memory(), dir.name, 'log');
    if (!fs.existsSync(logDir)) continue;

    const files = fs.readdirSync(logDir);
    for (const file of files) {
      // Match YYYY-MM-DD.md format
      const match = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (!match) continue;
      const fileDate = new Date(match[1]);
      if (fileDate < cutoff) {
        try {
          fs.unlinkSync(path.join(logDir, file));
          deleted++;
        } catch {
          errors++;
        }
      }
    }
  }

  return { deleted, errors };
}

// Memory-row retention moved to litectx: capture.js stamps each memory row with an
// expiresAt (admin rows live longer), and context.purge() reclaims expired rows.
// This module now owns only daily-log file pruning.

module.exports = { cleanupLogs };
