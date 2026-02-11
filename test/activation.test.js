const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { DocumentStore } = require('../src/indexer/store');

function makeChunk(id, content, scope = 'kb') {
  return {
    chunkId: id,
    filePath: '/test/doc.pdf',
    pageStart: 1,
    pageEnd: 1,
    elementType: 'paragraph',
    name: `chunk ${id}`,
    content,
    parentChunkId: null,
    sectionPath: [],
    sectionLevel: 0,
    documentType: 'pdf',
    metadata: {},
    scope,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

describe('ACT-R activation', () => {
  let store;

  before(() => {
    store = new DocumentStore(':memory:');
    store.saveChunk(makeChunk('act-1', 'neural network deep learning activation'));
    store.saveChunk(makeChunk('act-2', 'neural network convolutional training'));
    store.saveChunk(makeChunk('act-3', 'neural architecture search optimization'));
  });

  after(() => store.close());

  describe('computeActivation()', () => {
    it('returns 0 for chunk with no access history', () => {
      const act = store.computeActivation('act-1');
      assert.strictEqual(act, 0.0);
    });

    it('returns positive value after recording access', () => {
      store.recordAccess('act-1', 'test query');
      const act = store.computeActivation('act-1');
      assert.ok(act > 0, `activation should be positive, got ${act}`);
    });

    it('increases with more accesses', () => {
      const before = store.computeActivation('act-1');
      store.recordAccess('act-1', 'another query');
      store.recordAccess('act-1', 'yet another');
      const after = store.computeActivation('act-1');
      assert.ok(after > before, `activation should increase: ${before} -> ${after}`);
    });

    it('returns 0 for nonexistent chunk', () => {
      assert.strictEqual(store.computeActivation('nonexistent'), 0.0);
    });
  });

  describe('recordAccess()', () => {
    it('inserts into access_history', () => {
      const countBefore = store.db.prepare(
        "SELECT COUNT(*) as c FROM access_history WHERE chunk_id = 'act-2'"
      ).get().c;

      store.recordAccess('act-2', 'test');

      const countAfter = store.db.prepare(
        "SELECT COUNT(*) as c FROM access_history WHERE chunk_id = 'act-2'"
      ).get().c;

      assert.strictEqual(countAfter, countBefore + 1);
    });

    it('updates access_count on the chunk', () => {
      const before = store.db.prepare(
        "SELECT access_count FROM chunks WHERE chunk_id = 'act-3'"
      ).get().access_count;

      store.recordAccess('act-3', 'test');

      const after = store.db.prepare(
        "SELECT access_count FROM chunks WHERE chunk_id = 'act-3'"
      ).get().access_count;

      assert.strictEqual(after, before + 1);
    });

    it('caches computed activation on the chunk row', () => {
      store.recordAccess('act-3', 'cache test');
      const row = store.db.prepare(
        "SELECT activation FROM chunks WHERE chunk_id = 'act-3'"
      ).get();
      assert.ok(row.activation > 0, `cached activation should be positive, got ${row.activation}`);
    });
  });

  describe('recordSearchAccess()', () => {
    it('records access for multiple chunks in one call', () => {
      const ids = ['act-1', 'act-2'];
      const countsBefore = ids.map(id =>
        store.db.prepare("SELECT access_count FROM chunks WHERE chunk_id = ?").get(id).access_count
      );

      store.recordSearchAccess(ids, 'batch query');

      const countsAfter = ids.map(id =>
        store.db.prepare("SELECT access_count FROM chunks WHERE chunk_id = ?").get(id).access_count
      );

      assert.strictEqual(countsAfter[0], countsBefore[0] + 1);
      assert.strictEqual(countsAfter[1], countsBefore[1] + 1);
    });

    it('handles empty array gracefully', () => {
      assert.doesNotThrow(() => store.recordSearchAccess([], 'empty'));
      assert.doesNotThrow(() => store.recordSearchAccess(null, 'null'));
    });
  });

  describe('search with activation blending', () => {
    let freshStore;

    before(() => {
      freshStore = new DocumentStore(':memory:');
      // Two chunks with same content relevance for "machine learning"
      freshStore.saveChunk(makeChunk('ml-1', 'machine learning algorithms and models for classification'));
      freshStore.saveChunk(makeChunk('ml-2', 'machine learning algorithms and models for regression'));

      // Boost ml-2 with many accesses so activation pushes it above ml-1
      for (let i = 0; i < 10; i++) {
        freshStore.recordAccess('ml-2', 'machine learning');
      }
    });

    after(() => freshStore.close());

    it('returns results with activation and bm25 fields', () => {
      const results = freshStore.search('machine learning');
      assert.ok(results.length >= 2);
      assert.ok('activation' in results[0]);
      assert.ok('bm25' in results[0]);
      assert.ok('rank' in results[0]);
    });

    it('accessed chunk has higher activation than unaccessed', () => {
      const results = freshStore.search('machine learning');
      const ml1 = results.find(r => r.chunkId === 'ml-1');
      const ml2 = results.find(r => r.chunkId === 'ml-2');
      assert.ok(ml2.activation > ml1.activation,
        `ml-2 activation (${ml2.activation}) should be > ml-1 (${ml1.activation})`);
    });

    it('frequently accessed chunk ranks higher via blended score', () => {
      const results = freshStore.search('machine learning');
      const ml1idx = results.findIndex(r => r.chunkId === 'ml-1');
      const ml2idx = results.findIndex(r => r.chunkId === 'ml-2');
      assert.ok(ml2idx < ml1idx,
        `ml-2 (idx ${ml2idx}) should rank before ml-1 (idx ${ml1idx})`);
    });

    it('blended rank equals bm25 + weight * activation', () => {
      const results = freshStore.search('machine learning');
      for (const r of results) {
        const expected = r.bm25 + 2.0 * r.activation;
        assert.ok(Math.abs(r.rank - expected) < 0.001,
          `rank ${r.rank} should equal bm25 ${r.bm25} + 2.0 * activation ${r.activation} = ${expected}`);
      }
    });
  });
});
