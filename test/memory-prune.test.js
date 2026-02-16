const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ChatMemoryManager, getMemoryManager } = require('../src/memory/manager');

describe('ChatMemoryManager — pruneMemory', () => {
  let tmpDir;
  let origHome;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-mem-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMem(chatId, opts = {}) {
    const baseDir = path.join(tmpDir, '.multis', 'memory', 'chats');
    return new ChatMemoryManager(chatId, { ...opts, baseDir });
  }

  describe('pruneMemory()', () => {
    it('does nothing when memory is empty', () => {
      const mem = makeMem('prune-empty');
      mem.pruneMemory(5);
      assert.strictEqual(mem.loadMemory(), '');
    });

    it('does nothing when sections count is within limit', () => {
      const mem = makeMem('prune-within');
      mem.appendMemory('Note one');
      mem.appendMemory('Note two');
      mem.appendMemory('Note three');
      const before = mem.loadMemory();
      mem.pruneMemory(5);
      assert.strictEqual(mem.loadMemory(), before);
    });

    it('keeps only last N sections when over limit', () => {
      const mem = makeMem('prune-over');
      // Write 7 sections with distinct content
      for (let i = 1; i <= 7; i++) {
        mem.appendMemory(`Note number ${i}`);
      }
      mem.pruneMemory(3);
      const content = mem.loadMemory();
      // Should contain notes 5, 6, 7 but not 1, 2, 3, 4
      assert.ok(content.includes('Note number 5'), 'should keep note 5');
      assert.ok(content.includes('Note number 6'), 'should keep note 6');
      assert.ok(content.includes('Note number 7'), 'should keep note 7');
      assert.ok(!content.includes('Note number 1'), 'should have pruned note 1');
      assert.ok(!content.includes('Note number 2'), 'should have pruned note 2');
    });

    it('maxSections=1 keeps only the last section', () => {
      const mem = makeMem('prune-one');
      mem.appendMemory('First note');
      mem.appendMemory('Last note');
      mem.pruneMemory(1);
      const content = mem.loadMemory();
      assert.ok(content.includes('Last note'));
      assert.ok(!content.includes('First note'));
    });
  });

  describe('admin shared memory path', () => {
    it('admin memory path points to shared admin directory', () => {
      const mem = makeMem('admin-chat-1', { isAdmin: true });
      assert.ok(mem.memoryPath.includes('/admin/memory.md'), `path should include /admin/memory.md, got: ${mem.memoryPath}`);
    });

    it('non-admin memory path is per-chat', () => {
      const mem = makeMem('user-chat-1');
      assert.ok(mem.memoryPath.includes('/user-chat-1/memory.md'), `path should include chat dir, got: ${mem.memoryPath}`);
    });

    it('two admin chats share the same memory file', () => {
      const mem1 = makeMem('admin-a', { isAdmin: true });
      const mem2 = makeMem('admin-b', { isAdmin: true });
      assert.strictEqual(mem1.memoryPath, mem2.memoryPath);
    });

    it('admin memory persists across managers', () => {
      const mem1 = makeMem('admin-persist1', { isAdmin: true });
      mem1.appendMemory('Shared admin note');
      const mem2 = makeMem('admin-persist2', { isAdmin: true });
      const content = mem2.loadMemory();
      assert.ok(content.includes('Shared admin note'));
    });
  });

  describe('getMemoryManager cache', () => {
    const baseDir = () => path.join(tmpDir, '.multis', 'memory', 'chats');

    it('returns same instance for same chatId and role', () => {
      const cache = new Map();
      const m1 = getMemoryManager(cache, 'chat1', { baseDir: baseDir() });
      const m2 = getMemoryManager(cache, 'chat1', { baseDir: baseDir() });
      assert.strictEqual(m1, m2);
    });

    it('returns different instances for different chatIds', () => {
      const cache = new Map();
      const m1 = getMemoryManager(cache, 'chat1', { baseDir: baseDir() });
      const m2 = getMemoryManager(cache, 'chat2', { baseDir: baseDir() });
      assert.notStrictEqual(m1, m2);
    });

    it('returns different instances for admin vs user on same chatId', () => {
      const cache = new Map();
      const m1 = getMemoryManager(cache, 'chat1', { isAdmin: false, baseDir: baseDir() });
      const m2 = getMemoryManager(cache, 'chat1', { isAdmin: true, baseDir: baseDir() });
      assert.notStrictEqual(m1, m2);
    });
  });

  describe('trimRecent()', () => {
    it('trims to keepLast messages', () => {
      const mem = makeMem('trim-test');
      for (let i = 0; i < 10; i++) {
        mem.appendMessage('user', `msg ${i}`);
      }
      const trimmed = mem.trimRecent(3);
      assert.strictEqual(trimmed.length, 3);
      assert.strictEqual(trimmed[0].content, 'msg 7');
      assert.strictEqual(trimmed[2].content, 'msg 9');
    });

    it('does not trim when under threshold', () => {
      const mem = makeMem('trim-under');
      mem.appendMessage('user', 'hello');
      mem.appendMessage('assistant', 'hi');
      const trimmed = mem.trimRecent(5);
      assert.strictEqual(trimmed.length, 2);
    });
  });

  describe('shouldCapture()', () => {
    it('returns false when under threshold', () => {
      const mem = makeMem('capture-under');
      for (let i = 0; i < 5; i++) {
        mem.appendMessage('user', `msg ${i}`);
      }
      assert.strictEqual(mem.shouldCapture(20), false);
    });

    it('returns true when at threshold', () => {
      const mem = makeMem('capture-at');
      for (let i = 0; i < 20; i++) {
        mem.appendMessage('user', `msg ${i}`);
      }
      assert.strictEqual(mem.shouldCapture(20), true);
    });
  });
});

// --- runCapture tests ---

describe('runCapture — indexes summary, not raw messages', () => {
  let tmpDir;
  let origHome;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-capture-test-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes the LLM summary as a conversation chunk with correct scope', async () => {
    const { runCapture } = require('../src/memory/capture');
    const { DocumentStore } = require('../src/indexer/store');

    const dbPath = path.join(tmpDir, 'capture-test.db');
    const store = new DocumentStore(dbPath);

    // Create a memory manager using baseDir to avoid leaking into ~/.multis
    const baseDir = path.join(tmpDir, '.multis', 'memory', 'chats');
    const mem = new ChatMemoryManager('testchat', { baseDir });

    // Seed recent messages
    for (let i = 0; i < 10; i++) {
      mem.appendMessage('user', `Question ${i}`);
      mem.appendMessage('assistant', `Answer ${i}`);
    }

    // Mock LLM that returns a summary
    const mockLlm = {
      generate: async (prompt, opts) => {
        return '- User asked 10 questions about various topics\n- Answers were provided for each';
      }
    };

    // Mock indexer with our store
    const mockIndexer = { store };

    await runCapture('testchat', mem, mockLlm, mockIndexer, {
      keepLast: 5,
      scope: 'user:testchat',
      maxSections: 3
    });

    // Verify a chunk was stored
    const rows = store.db.prepare(
      "SELECT * FROM chunks WHERE document_type = 'conversation'"
    ).all();
    assert.ok(rows.length >= 1, 'Should have stored at least 1 conversation chunk');

    // Verify the chunk content is the summary, not raw messages
    const chunk = rows[0];
    assert.ok(chunk.content.includes('User asked 10 questions'), 'chunk should contain summary');
    assert.ok(!chunk.content.includes('Question 0'), 'chunk should NOT contain raw messages');

    // Verify scope
    assert.strictEqual(chunk.scope, 'user:testchat');

    // Verify element_type
    assert.strictEqual(chunk.element_type, 'memory_summary');

    // Verify recent was trimmed
    const remaining = mem.loadRecent();
    assert.strictEqual(remaining.length, 5);

    // Verify memory.md was appended
    const memContent = mem.loadMemory();
    assert.ok(memContent.includes('User asked 10 questions'));

    store.close();
  });

  it('skips indexing when LLM returns "no notable information"', async () => {
    const { runCapture } = require('../src/memory/capture');
    const { DocumentStore } = require('../src/indexer/store');

    const dbPath = path.join(tmpDir, 'capture-skip-test.db');
    const store = new DocumentStore(dbPath);

    const baseDir = path.join(tmpDir, '.multis', 'memory', 'chats');
    const mem = new ChatMemoryManager('skipchat', { baseDir });

    mem.appendMessage('user', 'hi');
    mem.appendMessage('assistant', 'hello');

    const mockLlm = {
      generate: async () => 'No notable information.'
    };
    const mockIndexer = { store };

    await runCapture('skipchat', mem, mockLlm, mockIndexer, { keepLast: 1 });

    const rows = store.db.prepare(
      "SELECT * FROM chunks WHERE document_type = 'conversation'"
    ).all();
    assert.strictEqual(rows.length, 0, 'Should not index when nothing notable');

    store.close();
  });
});
