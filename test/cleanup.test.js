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

  function createLogFile(chatId, dateStr, content = '# log') {
    const logDir = path.join(tmpDir, '.multis', 'data', 'memory', 'chats', chatId, 'log');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, `${dateStr}.md`), content);
  }

  it('deletes log files older than maxDays', () => {
    delete require.cache[require.resolve('../src/maintenance/cleanup')];
    delete require.cache[require.resolve('../src/config')];
    const { cleanupLogs } = require('../src/maintenance/cleanup');

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

    const recentPath = path.join(tmpDir, '.multis', 'data', 'memory', 'chats', 'chat1', 'log', `${recentStr}.md`);
    assert.ok(fs.existsSync(recentPath), 'recent log should still exist');

    const oldPath = path.join(tmpDir, '.multis', 'data', 'memory', 'chats', 'chat1', 'log', `${oldStr}.md`);
    assert.ok(!fs.existsSync(oldPath), 'old log should be deleted');
  });

  it('returns zero when no chats directory exists', () => {
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

    const logDir = path.join(tmpDir, '.multis', 'data', 'memory', 'chats', 'chat-skip', 'log');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'notes.txt'), 'not a date file');

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    fs.writeFileSync(path.join(logDir, `${oldDate.toISOString().slice(0, 10)}.md`), 'old');

    const result = cleanupLogs(30);
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
      INSERT INTO chunks (chunk_id, file_path, content, element_type, type, role, created_at, updated_at)
      VALUES (?, ?, ?, 'chat', 'conv', 'user:1', ?, ?)
    `).run('old-conv-1', 'memory/chats/1', 'old convo', oldDate.toISOString(), oldDate.toISOString());

    // Insert recent conversation chunk
    store.db.prepare(`
      INSERT INTO chunks (chunk_id, file_path, content, element_type, type, role, created_at, updated_at)
      VALUES (?, ?, ?, 'chat', 'conv', 'user:2', ?, ?)
    `).run('recent-conv-1', 'memory/chats/2', 'recent convo', recentDate.toISOString(), recentDate.toISOString());

    // Insert old NON-conversation chunk (should NOT be deleted)
    store.db.prepare(`
      INSERT INTO chunks (chunk_id, file_path, content, element_type, type, role, created_at, updated_at)
      VALUES (?, ?, ?, 'md', 'kb', 'public', ?, ?)
    `).run('old-doc-1', '/docs/old.md', 'old doc', oldDate.toISOString(), oldDate.toISOString());

    const deleted = pruneMemoryChunks(store, 90);
    assert.strictEqual(deleted, 1, 'should delete 1 old conversation chunk');

    const recent = store.db.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get('recent-conv-1');
    assert.ok(recent, 'recent conversation chunk should survive');

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

  it('admin chunks survive longer than user chunks', () => {
    delete require.cache[require.resolve('../src/maintenance/cleanup')];
    delete require.cache[require.resolve('../src/config')];
    const { pruneMemoryChunks } = require('../src/maintenance/cleanup');

    const now = new Date();
    const midDate = new Date(now);
    midDate.setDate(midDate.getDate() - 200);

    // Insert old user chunk — should be pruned at 90 days
    store.db.prepare(`
      INSERT INTO chunks (chunk_id, file_path, content, element_type, type, role, created_at, updated_at)
      VALUES (?, ?, ?, 'chat', 'conv', 'user:1', ?, ?)
    `).run('old-user-1', 'memory/chats/1', 'user convo', midDate.toISOString(), midDate.toISOString());

    // Insert old admin chunk — should survive at 200 days (< 365)
    store.db.prepare(`
      INSERT INTO chunks (chunk_id, file_path, content, element_type, type, role, created_at, updated_at)
      VALUES (?, ?, ?, 'chat', 'conv', 'admin', ?, ?)
    `).run('old-admin-1', 'memory/chats/admin', 'admin convo', midDate.toISOString(), midDate.toISOString());

    const deleted = pruneMemoryChunks(store, 90, 365);
    assert.strictEqual(deleted, 1, 'should delete user chunk but keep admin chunk');

    const adminChunk = store.db.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get('old-admin-1');
    assert.ok(adminChunk, 'admin chunk at 200 days should survive with 365-day retention');

    const userChunk = store.db.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get('old-user-1');
    assert.ok(!userChunk, 'user chunk at 200 days should be pruned with 90-day retention');
  });
});
