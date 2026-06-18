'use strict';
/**
 * Integration test for src/context — the litectx policy wrapper.
 *
 * Runs against the INSTALLED litectx (node_modules), not a mock, and proves the
 * security model multis depends on now that src/indexer is deleted:
 *   - per-CALL scope isolation: a customer recalls own ∪ global-KB, never another
 *     customer's rows, never admin's; the owner (admin) recalls admin ∪ global-KB,
 *     never a customer's (#6).
 *   - memory rides the doc axis (rememberMemory) but searchMemory filters to memory
 *     rows so the recall_memory tool never returns an uploaded document.
 *   - retention is enforced at write time via expiresAt; purge() reclaims expired rows
 *     (admin rows are given a longer life by capture.js — proven via expiresAt here).
 *   - get(id, scope) is fenced like recall (R2 handle fence).
 *
 * These replace the coverage from the deleted store-scope / recall-memory /
 * memory-prune / sqlite-smoke tests, which exercised the now-removed homegrown store.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { setMultisDir } = require('../../src/config');

// One LiteCtx per process: init once against a temp multis dir, reuse across cases.
let context;
let tmp;

const buf = (s) => Buffer.from(s, 'utf8');
const names = (hits) => hits.map((h) => h.content);

describe('context wrapper (litectx policy layer)', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-ctx-'));
    setMultisDir(tmp);
    // require AFTER setMultisDir so PATHS resolve under the temp dir.
    context = require('../../src/context');
    await context.init({ documents: {} });

    // Seed documents across scopes. All share the term "widget" so a single FTS
    // query matches every row — isolation must come from scope, not from the query.
    await context.indexBuffer(buf('# KB\nThe widget global knowledge base entry.'), 'kb.md', 'kb');
    await context.indexBuffer(buf('# Admin\nThe widget admin-private engineering note.'), 'admin.md', 'admin');
    await context.indexBuffer(buf('# A\nThe widget belonging to customer alpha.'), 'a.md', 'user:A');
    await context.indexBuffer(buf('# B\nThe widget belonging to customer beta.'), 'b.md', 'user:B');
  });

  after(() => {
    setMultisDir(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ingest reports chunk count for a parseable doc', async () => {
    const n = await context.indexBuffer(buf('# Extra\nA widget appendix paragraph.'), 'extra.md', 'kb');
    assert.ok(n >= 1, 'a non-empty markdown doc should produce at least one chunk');
  });

  it('customer recall sees own scope ∪ global-KB only (never another customer, never admin)', async () => {
    const hits = await context.search('widget', { scope: 'user:A', n: 20 });
    const text = names(hits).join('\n');
    assert.match(text, /customer alpha/, 'customer A sees its own doc');
    assert.match(text, /global knowledge base/, 'customer A sees the global KB');
    assert.doesNotMatch(text, /customer beta/, 'customer A must NOT see customer B (#6)');
    assert.doesNotMatch(text, /admin-private/, 'customer A must NOT see admin scope (#6)');
  });

  it('owner (admin) recall sees admin ∪ global-KB only (never a customer scope)', async () => {
    const hits = await context.search('widget', { scope: 'admin', n: 20 });
    const text = names(hits).join('\n');
    assert.match(text, /admin-private/, 'owner sees admin docs');
    assert.match(text, /global knowledge base/, 'owner sees the global KB');
    assert.doesNotMatch(text, /customer alpha/, 'owner must NOT be pulled into customer scopes (#6)');
    assert.doesNotMatch(text, /customer beta/, 'owner must NOT be pulled into customer scopes (#6)');
  });

  it('recall is fail-closed: an omitted scope throws instead of crossing tenants', async () => {
    // litectx recall({scope:null}) returns EVERY tenant, so a missing recall scope
    // must throw (fail-closed), not silently leak. The owner agentic job recalls with
    // an explicit scope:'admin' (admin ∪ global-KB), never unscoped.
    await assert.rejects(
      () => context.search('widget', { n: 20 }),
      /concrete scope is required/,
      'search() with no scope must throw, not see every scope'
    );
    await assert.rejects(
      () => context.searchMemory('widget', { n: 20 }),
      /concrete scope is required/,
      'searchMemory() with no scope must throw, not see every scope'
    );
    // 'public'/'kb' are write-only scopes; using one for recall would map to null
    // (every tenant) in litectx, so the wrapper rejects them on the recall axis too.
    await assert.rejects(
      () => context.search('widget', { scope: 'public', n: 20 }),
      /concrete scope is required/,
      "recall with the 'public' write-scope must throw"
    );
  });

  it('searchMemory returns memory rows only, never an uploaded document', async () => {
    await context.rememberMemory('admin', 'The widget meeting summary: ship on Friday.', {
      expiresAt: Date.now() + 86400_000,
    });
    // search() (RAG/doc tool) returns both docs and memory...
    const all = names(await context.search('widget', { scope: 'admin', n: 20 })).join('\n');
    assert.match(all, /admin-private/, 'search includes the uploaded admin doc');
    assert.match(all, /meeting summary/, 'search includes the memory row');
    // ...but searchMemory (recall_memory tool) returns only the memory row.
    const mem = names(await context.searchMemory('widget', { scope: 'admin', n: 20 })).join('\n');
    assert.match(mem, /meeting summary/, 'searchMemory returns the memory row');
    assert.doesNotMatch(mem, /admin-private/, 'searchMemory must NOT return uploaded documents');
  });

  it('memory recall is scope-fenced across tenants (#6)', async () => {
    await context.rememberMemory('user:A', 'The widget note for alpha only.', { expiresAt: Date.now() + 86400_000 });
    await context.rememberMemory('user:B', 'The widget note for beta only.', { expiresAt: Date.now() + 86400_000 });

    const a = names(await context.searchMemory('widget', { scope: 'user:A', n: 20 })).join('\n');
    assert.match(a, /alpha only/, 'A sees its own memory');
    assert.doesNotMatch(a, /beta only/, 'A must NOT see B memory');
    assert.doesNotMatch(a, /meeting summary/, 'A must NOT see admin memory');

    const adminMem = names(await context.searchMemory('widget', { scope: 'admin', n: 20 })).join('\n');
    assert.doesNotMatch(adminMem, /alpha only/, 'admin must NOT see customer memory');
    assert.doesNotMatch(adminMem, /beta only/, 'admin must NOT see customer memory');
  });

  it('memory carries a createdAt for the recall_memory date display', async () => {
    await context.rememberMemory('user:A', 'The widget dated note for alpha.', { expiresAt: Date.now() + 86400_000 });
    const hits = await context.searchMemory('dated', { scope: 'user:A', n: 5 });
    assert.ok(hits.length >= 1, 'the dated note is recalled');
    assert.match(hits[0].createdAt || '', /^\d{4}-\d{2}-\d{2}/, 'createdAt is an ISO timestamp');
  });

  it('purge reclaims expired memory rows and spares live ones', async () => {
    await context.rememberMemory('user:B', 'The widget ephemeral beta note.', { expiresAt: Date.now() - 1000 });
    await context.rememberMemory('user:B', 'The widget durable beta note.', { expiresAt: Date.now() + 86400_000 });

    const reclaimed = await context.purge();
    assert.ok(reclaimed >= 1, 'purge reclaims at least the expired row');

    const live = names(await context.searchMemory('ephemeral durable', { scope: 'user:B', n: 20 })).join('\n');
    assert.doesNotMatch(live, /ephemeral/, 'the expired row is gone after purge');
    assert.match(live, /durable/, 'the live row survives purge');
  });

  it('get(handle, scope) is fenced — a mismatched scope returns null', async () => {
    await context.rememberMemory('user:A', 'The widget secret handle for alpha.', { expiresAt: Date.now() + 86400_000 });
    // The recallable handle is the chunk path surfaced by search (name/chunkId),
    // not the doc-level id returned by ingest.
    const [hit] = await context.searchMemory('secret handle', { scope: 'user:A', n: 1 });
    assert.ok(hit && hit.name, 'the row is recalled and exposes a handle');

    const own = await context.get(hit.name, 'user:A');
    assert.ok(own, 'the owning scope can fetch the row by its handle');

    const other = await context.get(hit.name, 'user:B');
    assert.strictEqual(other, null, 'a foreign scope is fenced from the handle (R2)');
  });
});
