const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { DocumentStore } = require('../src/indexer/store');
const { DocChunk } = require('../src/indexer/chunk');

describe('DocumentStore — role support', () => {
  let store;
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-store-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    store = new DocumentStore(dbPath);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clear all chunks between tests
    store.db.exec('DELETE FROM chunks');
  });

  // --- Schema ---

  describe('schema', () => {
    it('role column exists after init', () => {
      const info = store.db.prepare("PRAGMA table_info(chunks)").all();
      const roleCol = info.find(c => c.name === 'role');
      assert.ok(roleCol, 'role column should exist on chunks table');
    });

    it('role column defaults to public', () => {
      const info = store.db.prepare("PRAGMA table_info(chunks)").all();
      const roleCol = info.find(c => c.name === 'role');
      assert.strictEqual(roleCol.dflt_value, "'public'");
    });

    it('type column exists after init', () => {
      const info = store.db.prepare("PRAGMA table_info(chunks)").all();
      const typeCol = info.find(c => c.name === 'type');
      assert.ok(typeCol, 'type column should exist on chunks table');
    });

    it('idx_chunks_role index exists', () => {
      const indexes = store.db.prepare("PRAGMA index_list(chunks)").all();
      const roleIdx = indexes.find(i => i.name === 'idx_chunks_role');
      assert.ok(roleIdx, 'role index should exist');
    });
  });

  // --- saveChunk with role ---

  describe('saveChunk with role', () => {
    it('saves a chunk with public role by default', () => {
      const chunk = new DocChunk({
        filePath: '/docs/readme.md',
        name: 'intro',
        content: 'Welcome to the documentation for the project.',
        element: 'md',
        type: 'kb'
      });
      store.saveChunk(chunk);
      const saved = store.getChunk(chunk.chunkId);
      assert.ok(saved);
      const row = store.db.prepare('SELECT role FROM chunks WHERE chunk_id = ?').get(chunk.chunkId);
      assert.strictEqual(row.role, 'public');
    });

    it('saves a chunk with admin role', () => {
      const chunk = new DocChunk({
        filePath: '/docs/internal.md',
        name: 'admin notes',
        content: 'Internal admin documentation private notes.',
        element: 'md',
        type: 'kb',
        role: 'admin'
      });
      store.saveChunk(chunk);
      const row = store.db.prepare('SELECT role FROM chunks WHERE chunk_id = ?').get(chunk.chunkId);
      assert.strictEqual(row.role, 'admin');
    });

    it('saves a chunk with user role', () => {
      const chunk = new DocChunk({
        filePath: 'memory/chats/user42',
        name: 'user memory',
        content: 'User specific memory conversation summary notes.',
        element: 'chat',
        type: 'conv',
        role: 'user:42'
      });
      store.saveChunk(chunk);
      const row = store.db.prepare('SELECT role FROM chunks WHERE chunk_id = ?').get(chunk.chunkId);
      assert.strictEqual(row.role, 'user:42');
    });
  });

  // --- Scoped search ---

  describe('scoped search', () => {
    beforeEach(() => {
      store.db.exec('DELETE FROM chunks');

      // Insert test chunks with different roles
      const chunks = [
        new DocChunk({
          filePath: '/docs/public.md',
          name: 'public info',
          content: 'The project documentation covers installation and configuration steps.',
          element: 'md',
          type: 'kb',
          role: 'public'
        }),
        new DocChunk({
          filePath: '/docs/admin.md',
          name: 'admin secrets',
          content: 'Administrative configuration requires special installation privileges.',
          element: 'md',
          type: 'kb',
          role: 'admin'
        }),
        new DocChunk({
          filePath: 'memory/chats/user99',
          name: 'user99 memory',
          content: 'This user prefers configuration via command line installation.',
          element: 'chat',
          type: 'conv',
          role: 'user:99'
        }),
        new DocChunk({
          filePath: 'memory/chats/user55',
          name: 'user55 memory',
          content: 'Another user discussed configuration options and installation.',
          element: 'chat',
          type: 'conv',
          role: 'user:55'
        }),
      ];
      store.saveChunks(chunks);
    });

    it('search without role returns all matching chunks', () => {
      const results = store.search('installation configuration');
      assert.ok(results.length >= 2, `Expected at least 2 results, got ${results.length}`);
    });

    it('search with public role returns only public chunks', () => {
      const results = store.search('installation configuration', 10, { roles: ['public'] });
      assert.ok(results.length >= 1);
      for (const r of results) {
        assert.strictEqual(r.role, 'public');
      }
    });

    it('search with admin role returns only admin chunks', () => {
      const results = store.search('installation configuration', 10, { roles: ['admin'] });
      assert.ok(results.length >= 1);
      for (const r of results) {
        assert.strictEqual(r.role, 'admin');
      }
    });

    it('search with user:99 role returns only that user chunks', () => {
      const results = store.search('installation configuration', 10, { roles: ['user:99'] });
      assert.ok(results.length >= 1);
      for (const r of results) {
        assert.strictEqual(r.role, 'user:99');
      }
    });

    it('search with multiple roles returns chunks from all specified roles', () => {
      const results = store.search('installation configuration', 10, { roles: ['public', 'admin'] });
      assert.ok(results.length >= 2);
      const roles = new Set(results.map(r => r.role));
      assert.ok(roles.has('public'));
      assert.ok(roles.has('admin'));
      assert.ok(!roles.has('user:99'));
      assert.ok(!roles.has('user:55'));
    });

    it('customer search sees only public + own user role', () => {
      const results = store.search('installation configuration', 10, { roles: ['public', 'user:99'] });
      const roles = new Set(results.map(r => r.role));
      assert.ok(!roles.has('admin'), 'customer should not see admin chunks');
      assert.ok(!roles.has('user:55'), 'customer should not see other user chunks');
    });

    it('admin search sees public + admin + all users', () => {
      const results = store.search('installation configuration', 10, { roles: ['public', 'admin', 'user:99', 'user:55'] });
      assert.ok(results.length >= 4);
    });

    it('search with empty roles array returns all', () => {
      const results = store.search('installation configuration', 10, { roles: [] });
      assert.ok(results.length >= 2);
    });

    it('returns empty for stopword-only query', () => {
      const results = store.search('the is a');
      assert.strictEqual(results.length, 0);
    });
  });

  // --- DocChunk role field ---

  describe('DocChunk role field', () => {
    it('defaults to public', () => {
      const chunk = new DocChunk({ filePath: '/test.md', content: 'test' });
      assert.strictEqual(chunk.role, 'public');
    });

    it('accepts custom role', () => {
      const chunk = new DocChunk({ filePath: '/test.md', content: 'test', role: 'admin' });
      assert.strictEqual(chunk.role, 'admin');
    });

    it('includes role in toJSON()', () => {
      const chunk = new DocChunk({ filePath: '/test.md', content: 'test', role: 'user:42' });
      const json = chunk.toJSON();
      assert.strictEqual(json.role, 'user:42');
    });

    it('generates deterministic chunk IDs', () => {
      const id1 = DocChunk.generateId('/a.md', 'name', 'content');
      const id2 = DocChunk.generateId('/a.md', 'name', 'content');
      assert.strictEqual(id1, id2);
    });

    it('chunk ID starts with doc: prefix', () => {
      const id = DocChunk.generateId('/a.md', 'n', 'c');
      assert.match(id, /^doc:[0-9a-f]{16}$/);
    });
  });
});
