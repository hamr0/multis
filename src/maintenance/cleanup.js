const fs = require('fs');
const path = require('path');
const { MULTIS_DIR } = require('../config');

const MEMORY_CHATS_DIR = path.join(MULTIS_DIR, 'memory', 'chats');

/**
 * Delete daily log files older than maxDays across all chat directories.
 * @returns {{ deleted: number, errors: number }}
 */
function cleanupLogs(maxDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  let deleted = 0;
  let errors = 0;

  if (!fs.existsSync(MEMORY_CHATS_DIR)) return { deleted, errors };

  const chatDirs = fs.readdirSync(MEMORY_CHATS_DIR, { withFileTypes: true });
  for (const dir of chatDirs) {
    if (!dir.isDirectory()) continue;
    const logDir = path.join(MEMORY_CHATS_DIR, dir.name, 'log');
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

/**
 * Delete old conversation memory chunks from the store.
 * Admin-scoped chunks get longer retention (default 365 days).
 * @param {import('../indexer/store').DocumentStore} store
 * @param {number} maxDays - retention for non-admin chunks (default 90)
 * @param {number} [adminMaxDays] - retention for admin chunks (default 365)
 * @returns {number} - Number of chunks deleted
 */
function pruneMemoryChunks(store, maxDays = 90, adminMaxDays = 365) {
  const userCutoff = new Date();
  userCutoff.setDate(userCutoff.getDate() - maxDays);
  const adminCutoff = new Date();
  adminCutoff.setDate(adminCutoff.getDate() - adminMaxDays);

  // Delete non-admin conversation chunks older than maxDays
  const userResult = store.db.prepare(
    "DELETE FROM chunks WHERE type = 'conv' AND role != 'admin' AND created_at < ?"
  ).run(userCutoff.toISOString());

  // Delete admin conversation chunks older than adminMaxDays
  const adminResult = store.db.prepare(
    "DELETE FROM chunks WHERE type = 'conv' AND role = 'admin' AND created_at < ?"
  ).run(adminCutoff.toISOString());

  return userResult.changes + adminResult.changes;
}

module.exports = { cleanupLogs, pruneMemoryChunks };
