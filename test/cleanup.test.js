const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('cleanupLogs', () => {
  let tmpDir;
  let origHome;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-cleanup-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // We need to re-require the module after setting HOME so MULTIS_DIR picks up the tmp path.
  // The module caches MULTIS_DIR at require time from config.js, so we must work around that.
  // Instead we will create the expected directory structure manually and then call the function.

  function createLogFile(chatId, dateStr, content = '# log') {
    const logDir = path.join(tmpDir, '.multis', 'memory', 'chats', chatId, 'log');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, `${dateStr}.md`), content);
  }

  it('deletes log files older than maxDays', () => {
    // We need to call cleanupLogs with the right MEMORY_CHATS_DIR.
    // Since cleanup.js hardcodes MULTIS_DIR from config.js which uses process.env.HOME at require time,
    // and we set HOME before requiring, we can re-require it.

    // Force re-require
    delete require.cache[require.resolve('../src/maintenance/cleanup')];
    delete require.cache[require.resolve('../src/config')];
    const { cleanupLogs } = require('../src/maintenance/cleanup');

    // Create old and new log files
    const today = new Date();
    const recentDate = new Date(today);
    recentDate.setDate(recentDate.getDate() - 5);
    const oldDate = new Date(today);
    oldDate.setDate(oldDate.getDate() - 45);

    const recentStr = recentDate.toISOString().slice(0, 10);
    const oldStr = oldDate.toISOString().slice(0, 10);

    createLogFile('chat1', recentStr, 'recent log');
    createLogFile('chat1', oldStr, 'old log');
    createLogFile('chat2', oldStr, 'old log 2');

    const result = cleanupLogs(30);
    assert.strictEqual(result.deleted, 2, 'should delete 2 old files');
    assert.strictEqual(result.errors, 0);

    // Recent file should still exist
    const recentPath = path.join(tmpDir, '.multis', 'memory', 'chats', 'chat1', 'log', `${recentStr}.md`);
    assert.ok(fs.existsSync(recentPath), 'recent log should still exist');

    // Old files should be gone
    const oldPath = path.join(tmpDir, '.multis', 'memory', 'chats', 'chat1', 'log', `${oldStr}.md`);
    assert.ok(!fs.existsSync(oldPath), 'old log should be deleted');
  });

  it('returns zero when no chats directory exists', () => {
    // Use a fresh HOME with no memory dir
    const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-cleanup-empty-'));
    const prevHome = process.env.HOME;
    process.env.HOME = freshTmp;

    delete require.cache[require.resolve('../src/maintenance/cleanup')];
    delete require.cache[require.resolve('../src/config')];
    const { cleanupLogs } = require('../src/maintenance/cleanup');

    const result = cleanupLogs(30);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.errors, 0);

    process.env.HOME = prevHome;
    fs.rmSync(freshTmp, { recursive: true, force: true });
  });

  it('skips non-date files in log directories', () => {
    delete require.cache[require.resolve('../src/maintenance/cleanup')];
    delete require.cache[require.resolve('../src/config')];
    process.env.HOME = tmpDir;
    const { cleanupLogs } = require('../src/maintenance/cleanup');

    // Create a non-date file
    const logDir = path.join(tmpDir, '.multis', 'memory', 'chats', 'chat-skip', 'log');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'notes.txt'), 'not a date file');

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    fs.writeFileSync(path.join(logDir, `${oldDate.toISOString().slice(0, 10)}.md`), 'old');

    const result = cleanupLogs(30);
    // Should delete the old .md file but skip notes.txt
    assert.ok(fs.existsSync(path.join(logDir, 'notes.txt')), 'non-date file should be preserved');
  });
});

describe('pruneMemoryChunks', () => {
  let tmpDir;
  let store;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-prune-chunks-'));
    const { DocumentStore } = require('../src/indexer/store');
    store = new DocumentStore(path.join(tmpDir, 'prune.db'));
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store.db.exec('DELETE FROM chunks');
  });

  it('deletes conversation chunks older than maxDays', () => {
    // Need to re-require to be safe
    delete require.cache[require.resolve('../src/maintenance/cleanup')];
    delete require.cache[require.resolve('../src/config')];
    const { pruneMemoryChunks } = require('../src/maintenance/cleanup');

    const now = new Date();
    const oldDate = new Date(now);
    oldDate.setDate(oldDate.getDate() - 100);
    const recentDate = new Date(now);
    recentDate.setDate(recentDate.getDate() - 10);

    // Insert old conversation chunk
    store.db.prepare(`
      INSERT INTO chunks (chunk_id, file_path, content, document_type, scope, created_at, updated_at)
      VALUES (?, ?, ?, 'conversation', 'user:1', ?, ?)
    `).run('old-conv-1', 'memory/chats/1', 'old convo', oldDate.toISOString(), oldDate.toISOString());

    // Insert recent conversation chunk
    store.db.prepare(`
      INSERT INTO chunks (chunk_id, file_path, content, document_type, scope, created_at, updated_at)
      VALUES (?, ?, ?, 'conversation', 'user:2', ?, ?)
    `).run('recent-conv-1', 'memory/chats/2', 'recent convo', recentDate.toISOString(), recentDate.toISOString());

    // Insert old NON-conversation chunk (should NOT be deleted)
    store.db.prepare(`
      INSERT INTO chunks (chunk_id, file_path, content, document_type, scope, created_at, updated_at)
      VALUES (?, ?, ?, 'md', 'kb', ?, ?)
    `).run('old-doc-1', '/docs/old.md', 'old doc', oldDate.toISOString(), oldDate.toISOString());

    const deleted = pruneMemoryChunks(store, 90);
    assert.strictEqual(deleted, 1, 'should delete 1 old conversation chunk');

    // Verify recent conversation chunk still exists
    const recent = store.db.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get('recent-conv-1');
    assert.ok(recent, 'recent conversation chunk should survive');

    // Verify non-conversation chunk still exists
    const doc = store.db.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get('old-doc-1');
    assert.ok(doc, 'non-conversation chunk should survive regardless of age');
  });

  it('returns 0 when nothing to prune', () => {
    delete require.cache[require.resolve('../src/maintenance/cleanup')];
    delete require.cache[require.resolve('../src/config')];
    const { pruneMemoryChunks } = require('../src/maintenance/cleanup');

    const deleted = pruneMemoryChunks(store, 90);
    assert.strictEqual(deleted, 0);
  });
});
