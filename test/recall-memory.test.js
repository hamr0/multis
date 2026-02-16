const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { DocumentStore } = require('../src/indexer/store');
const { TOOLS } = require('../src/tools/definitions');

const recallTool = TOOLS.find(t => t.name === 'recall_memory');

describe('recall_memory tool', () => {
  let store;
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-recall-test-'));
    store = new DocumentStore(path.join(tmpDir, 'test.db'));

    const now = new Date().toISOString();
    // Memory summary chunks
    store.saveChunk({
      chunkId: 'mem-1', filePath: 'memory/chats/owner1', pageStart: 0, pageEnd: 0,
      elementType: 'memory_summary', name: 'Memory capture',
      content: 'User mentioned their cat is named Luna and they live in Berlin',
      parentChunkId: null, sectionPath: '["owner1"]', sectionLevel: 0,
      documentType: 'conversation', metadata: '{}', scope: 'admin',
      createdAt: '2026-02-10T12:00:00Z', updatedAt: now
    });
    store.saveChunk({
      chunkId: 'mem-2', filePath: 'memory/chats/customer42', pageStart: 0, pageEnd: 0,
      elementType: 'memory_summary', name: 'Memory capture',
      content: 'Customer asked about refund policy for their order',
      parentChunkId: null, sectionPath: '["customer42"]', sectionLevel: 0,
      documentType: 'conversation', metadata: '{}', scope: 'user:customer42',
      createdAt: '2026-02-11T08:00:00Z', updatedAt: now
    });
    // A document chunk (should NOT appear in recall_memory results)
    store.saveChunk({
      chunkId: 'doc-1', filePath: '/docs/pets.pdf', pageStart: 1, pageEnd: 1,
      elementType: 'paragraph', name: 'Pet Care Guide',
      content: 'Cats need regular veterinary checkups and a balanced diet with Luna brand food',
      parentChunkId: null, sectionPath: '["Pet Care"]', sectionLevel: 0,
      documentType: 'pdf', metadata: '{}', scope: 'kb',
      createdAt: now, updatedAt: now
    });
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns only memory_summary chunks, not documents', async () => {
    const ctx = { indexer: { store }, isOwner: true, chatId: 'owner1' };
    const result = await recallTool.execute({ query: 'cat Luna' }, ctx);
    assert.ok(result.includes('cat is named Luna'), 'should find memory about Luna');
    assert.ok(!result.includes('Pet Care Guide'), 'should not include document chunks');
    assert.ok(!result.includes('Luna brand food'), 'should not include doc content');
  });

  it('owner can see all memory scopes', async () => {
    const ctx = { indexer: { store }, isOwner: true, chatId: 'owner1' };
    const result = await recallTool.execute({ query: 'refund order' }, ctx);
    assert.ok(result.includes('refund policy'), 'owner should see customer memory');
  });

  it('non-owner only sees their own scoped memories', async () => {
    const ctx = { indexer: { store }, isOwner: false, chatId: 'customer42' };
    const result = await recallTool.execute({ query: 'cat Luna Berlin' }, ctx);
    assert.strictEqual(result, 'No matching memories found.',
      'customer should not see admin memory');
  });

  it('non-owner can see their own memories', async () => {
    const ctx = { indexer: { store }, isOwner: false, chatId: 'customer42' };
    const result = await recallTool.execute({ query: 'refund order' }, ctx);
    assert.ok(result.includes('refund policy'), 'customer should see own memory');
  });

  it('returns empty message when no matches', async () => {
    const ctx = { indexer: { store }, isOwner: true, chatId: 'owner1' };
    const result = await recallTool.execute({ query: 'quantum physics spacetime' }, ctx);
    assert.strictEqual(result, 'No matching memories found.');
  });

  it('returns fallback when indexer is not available', async () => {
    const ctx = { indexer: null, isOwner: true, chatId: 'owner1' };
    const result = await recallTool.execute({ query: 'anything' }, ctx);
    assert.strictEqual(result, 'Memory search not available.');
  });

  it('includes date in results', async () => {
    const ctx = { indexer: { store }, isOwner: true, chatId: 'owner1' };
    const result = await recallTool.execute({ query: 'cat Luna' }, ctx);
    assert.ok(result.includes('2026-02-10'), 'should include the date from createdAt');
  });
});
