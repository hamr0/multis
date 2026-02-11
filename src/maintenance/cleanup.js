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
 * @param {import('../indexer/store').DocumentStore} store
 * @param {number} maxDays
 * @returns {number} - Number of chunks deleted
 */
function pruneMemoryChunks(store, maxDays = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  const cutoffStr = cutoff.toISOString();

  const result = store.db.prepare(
    "DELETE FROM chunks WHERE document_type = 'conversation' AND created_at < ?"
  ).run(cutoffStr);

  return result.changes;
}

module.exports = { cleanupLogs, pruneMemoryChunks };
