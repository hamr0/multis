const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { DocumentStore } = require('../src/indexer/store');
const { DocChunk } = require('../src/indexer/chunk');

describe('DocumentStore — scope support', () => {
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

  // --- Schema migration ---

  describe('schema migration', () => {
    it('scope column exists after init', () => {
      const info = store.db.prepare("PRAGMA table_info(chunks)").all();
      const scopeCol = info.find(c => c.name === 'scope');
      assert.ok(scopeCol, 'scope column should exist on chunks table');
    });

    it('scope column defaults to kb', () => {
      const info = store.db.prepare("PRAGMA table_info(chunks)").all();
      const scopeCol = info.find(c => c.name === 'scope');
      assert.strictEqual(scopeCol.dflt_value, "'kb'");
    });

    it('idx_chunks_scope index exists', () => {
      const indexes = store.db.prepare("PRAGMA index_list(chunks)").all();
      const scopeIdx = indexes.find(i => i.name === 'idx_chunks_scope');
      assert.ok(scopeIdx, 'scope index should exist');
    });
  });

  // --- saveChunk with scope ---

  describe('saveChunk with scope', () => {
    it('saves a chunk with kb scope by default', () => {
      const chunk = new DocChunk({
        filePath: '/docs/readme.md',
        name: 'intro',
        content: 'Welcome to the documentation for the project.',
        documentType: 'md'
      });
      store.saveChunk(chunk);
      const saved = store.getChunk(chunk.chunkId);
      assert.ok(saved);
      // getChunk does not return scope, so query directly
      const row = store.db.prepare('SELECT scope FROM chunks WHERE chunk_id = ?').get(chunk.chunkId);
      assert.strictEqual(row.scope, 'kb');
    });

    it('saves a chunk with admin scope', () => {
      const chunk = new DocChunk({
        filePath: '/docs/internal.md',
        name: 'admin notes',
        content: 'Internal admin documentation private notes.',
        documentType: 'md',
        scope: 'admin'
      });
      store.saveChunk(chunk);
      const row = store.db.prepare('SELECT scope FROM chunks WHERE chunk_id = ?').get(chunk.chunkId);
      assert.strictEqual(row.scope, 'admin');
    });

    it('saves a chunk with user scope', () => {
      const chunk = new DocChunk({
        filePath: 'memory/chats/user42',
        name: 'user memory',
        content: 'User specific memory conversation summary notes.',
        documentType: 'conversation',
        scope: 'user:42'
      });
      store.saveChunk(chunk);
      const row = store.db.prepare('SELECT scope FROM chunks WHERE chunk_id = ?').get(chunk.chunkId);
      assert.strictEqual(row.scope, 'user:42');
    });
  });

  // --- Scoped search ---

  describe('scoped search', () => {
    beforeEach(() => {
      store.db.exec('DELETE FROM chunks');

      // Insert test chunks with different scopes
      const chunks = [
        new DocChunk({
          filePath: '/docs/public.md',
          name: 'public info',
          content: 'The project documentation covers installation and configuration steps.',
          documentType: 'md',
          scope: 'kb'
        }),
        new DocChunk({
          filePath: '/docs/admin.md',
          name: 'admin secrets',
          content: 'Administrative configuration requires special installation privileges.',
          documentType: 'md',
          scope: 'admin'
        }),
        new DocChunk({
          filePath: 'memory/chats/user99',
          name: 'user99 memory',
          content: 'This user prefers configuration via command line installation.',
          documentType: 'conversation',
          scope: 'user:99'
        }),
        new DocChunk({
          filePath: 'memory/chats/user55',
          name: 'user55 memory',
          content: 'Another user discussed configuration options and installation.',
          documentType: 'conversation',
          scope: 'user:55'
        }),
      ];
      store.saveChunks(chunks);
    });

    it('search without scope returns all matching chunks', () => {
      const results = store.search('installation configuration');
      assert.ok(results.length >= 2, `Expected at least 2 results, got ${results.length}`);
    });

    it('search with kb scope returns only kb chunks', () => {
      const results = store.search('installation configuration', 10, { scopes: ['kb'] });
      assert.ok(results.length >= 1);
      for (const r of results) {
        assert.strictEqual(r.scope, 'kb');
      }
    });

    it('search with admin scope returns only admin chunks', () => {
      const results = store.search('installation configuration', 10, { scopes: ['admin'] });
      assert.ok(results.length >= 1);
      for (const r of results) {
        assert.strictEqual(r.scope, 'admin');
      }
    });

    it('search with user:99 scope returns only that user chunks', () => {
      const results = store.search('installation configuration', 10, { scopes: ['user:99'] });
      assert.ok(results.length >= 1);
      for (const r of results) {
        assert.strictEqual(r.scope, 'user:99');
      }
    });

    it('search with multiple scopes returns chunks from all specified scopes', () => {
      const results = store.search('installation configuration', 10, { scopes: ['kb', 'admin'] });
      assert.ok(results.length >= 2);
      const scopes = new Set(results.map(r => r.scope));
      assert.ok(scopes.has('kb'));
      assert.ok(scopes.has('admin'));
      assert.ok(!scopes.has('user:99'));
      assert.ok(!scopes.has('user:55'));
    });

    it('customer search sees only kb + own user scope', () => {
      const results = store.search('installation configuration', 10, { scopes: ['kb', 'user:99'] });
      const scopes = new Set(results.map(r => r.scope));
      assert.ok(!scopes.has('admin'), 'customer should not see admin chunks');
      assert.ok(!scopes.has('user:55'), 'customer should not see other user chunks');
    });

    it('admin search sees kb + admin + all users', () => {
      const results = store.search('installation configuration', 10, { scopes: ['kb', 'admin', 'user:99', 'user:55'] });
      assert.ok(results.length >= 4);
    });

    it('search with empty scopes array returns all', () => {
      const results = store.search('installation configuration', 10, { scopes: [] });
      assert.ok(results.length >= 2);
    });

    it('returns empty for stopword-only query', () => {
      const results = store.search('the is a');
      assert.strictEqual(results.length, 0);
    });
  });

  // --- DocChunk scope field ---

  describe('DocChunk scope field', () => {
    it('defaults to kb', () => {
      const chunk = new DocChunk({ filePath: '/test.md', content: 'test' });
      assert.strictEqual(chunk.scope, 'kb');
    });

    it('accepts custom scope', () => {
      const chunk = new DocChunk({ filePath: '/test.md', content: 'test', scope: 'admin' });
      assert.strictEqual(chunk.scope, 'admin');
    });

    it('includes scope in toJSON()', () => {
      const chunk = new DocChunk({ filePath: '/test.md', content: 'test', scope: 'user:42' });
      const json = chunk.toJSON();
      assert.strictEqual(json.scope, 'user:42');
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
