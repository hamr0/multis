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

  it('recall is fail-closed: a missing scope throws; "public" is KB-only, never every tenant', async () => {
    // litectx strictScope + the wrapper's toScope both reject a missing scope, so a
    // forgotten scope throws (fail-closed) rather than returning every tenant. The owner
    // agentic job recalls with an explicit scope:'admin' (admin ∪ global-KB), never unscoped.
    await assert.rejects(
      () => context.search('widget', { n: 20 }),
      /scope is required/,
      'search() with no scope must throw, not see every scope'
    );
    await assert.rejects(
      () => context.searchMemory('widget', { n: 20 }),
      /scope is required/,
      'searchMemory() with no scope must throw, not see every scope'
    );
    // 'public'/'kb' map to litectx GLOBAL — the shared KB only (never a tenant). A naive
    // 'public' recall now returns exactly the KB, the safe thing a caller would expect —
    // NOT the old fail-open "every tenant".
    const kb = names(await context.search('widget', { scope: 'public', n: 20 })).join('\n');
    assert.match(kb, /global knowledge base/, "'public' recall returns the shared KB");
    assert.doesNotMatch(kb, /customer alpha|customer beta|admin-private/, "'public' recall returns ONLY the KB");
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

  // ---------------------------------------------------------------------------
  // SEC2 — untrusted-input parser bounds. multis maps config.documents → litectx
  // (src/index.js: setBounds(config.documents)); litectx 0.18.0 enforces them
  // deterministically BEFORE any parse/store, so an over-limit upload is rejected
  // without OOM. These prove multis WIRES the configured value through (not that
  // litectx merely has a default): each bound is set BELOW litectx's own default
  // (maxSize 10MB / maxPages 2000), so the rejection can only come from the value
  // multis passed — if the wiring broke, the over-limit input would ingest under
  // litectx's looser default and the test would fail. Same format in each pair, so
  // the size / page count is the only discriminator. Runs against the INSTALLED
  // litectx.
  //
  // Honest scope: maxSize and maxPages are deterministic caps. litectx's
  // parseTimeoutMs is a PER-PAGE wall-clock guard that cannot interrupt a single
  // CPU-bound page (no worker thread) — documented upstream, not asserted here.
  describe('SEC2 — config.documents bounds rejection (litectx enforcement)', () => {
    const MB = 1024 * 1024;
    // Restore the file's default (empty → litectx defaults) so later state is clean.
    after(() => context.setBounds({}));

    it('rejects a buffer over maxSize before parse/store (sub-default bound proves the wiring)', async () => {
      context.setBounds({ maxSize: 1 * MB, maxPdfPages: 2000, parseTimeoutMs: 30000 });
      // An under-limit doc of the SAME format ingests → the rejection is the byte
      // cap, not a content/format quirk.
      const under = buf('# Doc\n' + 'The widget fox jumps over the lazy dog. '.repeat(8000)); // ~0.3MB
      assert.ok((await context.indexBuffer(under, 'under.md', 'kb')) >= 1, 'an under-limit doc ingests');
      // 2MB > the 1MB bound multis wired (and < litectx's 10MB default — so a
      // rejection here can ONLY be multis's configured cap).
      await assert.rejects(
        () => context.indexBuffer(Buffer.alloc(2 * MB, 'x'), 'over.md', 'kb'),
        /exceeds maxSize/,
        'a 2MB buffer is rejected at the 1MB configured bound'
      );
    });

    it('rejects a PDF over maxPages (page count is the discriminator)', async () => {
      const pdf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'two-page.pdf'));
      // At a 2-page cap the same PDF ingests; at a 1-page cap it is rejected — and
      // 1 is below litectx's 2000 default, so the cap is multis's configured value.
      context.setBounds({ maxSize: 10 * MB, maxPdfPages: 2, parseTimeoutMs: 30000 });
      assert.ok((await context.indexBuffer(pdf, 'ok.pdf', 'kb')) >= 1, 'a 2-page PDF ingests at a 2-page cap');

      context.setBounds({ maxSize: 10 * MB, maxPdfPages: 1, parseTimeoutMs: 30000 });
      await assert.rejects(
        () => context.indexBuffer(pdf, 'toomany.pdf', 'kb'),
        /exceeds maxPages/,
        'a 2-page PDF is rejected at a 1-page cap'
      );
    });
  });
});
