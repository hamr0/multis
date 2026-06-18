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
