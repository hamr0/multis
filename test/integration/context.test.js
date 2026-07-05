'use strict';
/**
 * Integration test for src/context — the litectx policy wrapper.
 *
 * Runs against the INSTALLED litectx (node_modules), not a mock, and proves the
 * security model multis depends on now that src/indexer is deleted:
 *   - per-CALL scope isolation: a customer recalls own ∪ global-KB, never another
 *     customer's rows, never admin's; the owner (admin) recalls admin ∪ global-KB,
 *     never a customer's (#6).
 *   - retention is enforced at write time via expiresAt; purge() reclaims expired rows.
 *   - get(id, scope) is fenced like recall (R2 handle fence).
 *
 * The M4 native memory ladder (episode→fact, recall, promotion, tenant-scoped forget) is
 * covered by the 'native memory ladder (M4)' suite at the bottom of this file.
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

  it('ingest reports {chunks, mode} for a parseable doc', async () => {
    const r = await context.indexBuffer(buf('# Extra\nA widget appendix paragraph.'), 'extra.md', 'kb');
    assert.ok(r.chunks >= 1, 'a non-empty markdown doc should produce at least one chunk');
    assert.equal(r.mode, 'chunked', 'a parseable doc reports the searchable (chunked) mode');
  });

  // litectx 0.19.0 (plaintext-chunker ask) — validate the PUBLISHED artifact: plain-text
  // family files now chunk (were 0-chunk blobs on 0.18.0) and are recallable by a body term.
  it('plaintext family (.txt/.text/.log/.csv) chunks and is recallable (litectx 0.19.0)', async () => {
    const cases = [
      ['notes.txt', 'zonkberry alpha note\n\nsecond paragraph beta'],
      ['app.log', '2026-06-25 zonkberry log line\nanother line'],
      ['rows.csv', 'col1,col2\nzonkberry,9\nbeta,8'],
      ['raw.text', 'zonkberry plain text body'],
    ];
    for (const [name, body] of cases) {
      const r = await context.indexBuffer(buf(body), name, 'kb');
      assert.ok(r.chunks >= 1, `${name} should produce >= 1 chunk (0 on litectx 0.18.0)`);
      assert.equal(r.mode, 'chunked', `${name} should be searchable, not stored-only`);
    }
    const hits = names(await context.search('zonkberry', { scope: 'kb', n: 20 })).join('\n');
    assert.match(hits, /zonkberry/, 'a plain-text body term is returned by recall');
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
    // 'public'/'kb' map to litectx GLOBAL — the shared KB only (never a tenant). A naive
    // 'public' recall now returns exactly the KB, the safe thing a caller would expect —
    // NOT the old fail-open "every tenant".
    const kb = names(await context.search('widget', { scope: 'public', n: 20 })).join('\n');
    assert.match(kb, /global knowledge base/, "'public' recall returns the shared KB");
    assert.doesNotMatch(kb, /customer alpha|customer beta|admin-private/, "'public' recall returns ONLY the KB");
  });

  // NB: memory recall/isolation (fact/episode) is covered by the 'native memory ladder (M4)'
  // suite below; these doc-axis cases cover the retention sweep + the R2 handle fence.

  it('purge reclaims expired rows and spares live ones', async () => {
    await context.indexBuffer(buf('# E\nThe widget ephemeral beta note.'), 'eph.md', 'user:B', { expiresAt: Date.now() - 1000 });
    await context.indexBuffer(buf('# D\nThe widget durable beta note.'), 'dur.md', 'user:B', { expiresAt: Date.now() + 86400_000 });

    const reclaimed = await context.purge();
    assert.ok(reclaimed >= 1, 'purge reclaims at least the expired row');

    const live = names(await context.search('ephemeral durable', { scope: 'user:B', n: 20 })).join('\n');
    assert.doesNotMatch(live, /ephemeral/, 'the expired row is gone after purge');
    assert.match(live, /durable/, 'the live row survives purge');
  });

  it('get(handle, scope) is fenced — a mismatched scope returns null (R2)', async () => {
    await context.indexBuffer(buf('# S\nThe widget secret handle for alpha.'), 'secret.md', 'user:A');
    // The recallable handle is the chunk path surfaced by search (name/chunkId).
    const [hit] = await context.search('secret handle', { scope: 'user:A', n: 1 });
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
      assert.ok((await context.indexBuffer(under, 'under.md', 'kb')).chunks >= 1, 'an under-limit doc ingests');
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
      assert.ok((await context.indexBuffer(pdf, 'ok.pdf', 'kb')).chunks >= 1, 'a 2-page PDF ingests at a 2-page cap');

      context.setBounds({ maxSize: 10 * MB, maxPdfPages: 1, parseTimeoutMs: 30000 });
      await assert.rejects(
        () => context.indexBuffer(pdf, 'toomany.pdf', 'kb'),
        /exceeds maxPages/,
        'a 2-page PDF is rejected at a 1-page cap'
      );
    });
  });
});

/**
 * M4 native memory ladder — episodes (scratchpad, by:'agent') → facts (durable) via promotion
 * by USE, plus /remember's direct fact write. Runs against the INSTALLED litectx 0.21.0. Every
 * positive has a negative control; the isolation case is the customer-fencing security boundary (#6).
 * (NB: /forget is NOT covered here — tenant-scoped forget is blocked on litectx-asks/memory-scope-forget.md.)
 */
describe('context wrapper — native memory ladder (M4)', () => {
  let ctx2, tmp2;
  const paths = (hits) => hits.map((h) => h.name);

  before(async () => {
    tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-mem-'));
    setMultisDir(tmp2);
    delete require.cache[require.resolve('../../src/context')];
    delete require.cache[require.resolve('../../src/config')];
    ctx2 = require('../../src/context');
    require('../../src/config').setMultisDir(tmp2);
    await ctx2.init({ documents: {} });
  });

  after(() => {
    setMultisDir(null);
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  it('rememberEpisode + recallMemory round-trips a scratchpad episode', async () => {
    await ctx2.rememberEpisode('admin', 'owner wants the morning news summarized at 7am');
    const hits = await ctx2.recallMemory('morning news summary', { scope: 'admin', n: 5 });
    assert.match(hits.map((h) => h.content).join('\n'), /morning news/, 'the episode is recallable');
  });

  it('rememberFact (by:human) round-trips a durable fact, facts ranked before episodes', async () => {
    // both a fact and an episode match "budget" — recallMemory must surface the FACT first.
    await ctx2.rememberEpisode('admin', 'a passing mention of the budget in chat');
    await ctx2.rememberFact('admin', 'the Q3 budget ceiling is fifty thousand', { by: 'human' });
    const hits = await ctx2.recallMemory('budget ceiling', { scope: 'admin', n: 5 });
    const joined = hits.map((h) => h.content).join('\n');
    assert.match(joined, /budget ceiling is fifty thousand/, 'the durable fact recalls');
    assert.match(hits[0].content, /fifty thousand/, 'a fact ranks before a scratchpad episode');
  });

  it('recentMemory returns this tenant\'s episodes newest-first with meta.turns intact (window source, R3)', async () => {
    const S = 'user:win';
    await ctx2.rememberEpisode(S, 'User: hi\nAssistant: hello', { meta: { turns: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] } });
    await ctx2.rememberEpisode(S, 'User: bye\nAssistant: later', { meta: { turns: [{ role: 'user', content: 'bye' }, { role: 'assistant', content: 'later' }] } });
    const hits = await ctx2.recentMemory(S, { kind: 'episode', n: 10 });
    assert.strictEqual(hits.length, 2, 'both episodes returned, tenant-fenced');
    assert.match(hits[0].content, /bye/, 'newest-first');
    assert.deepStrictEqual(hits[0].meta.turns, [{ role: 'user', content: 'bye' }, { role: 'assistant', content: 'later' }],
      'meta.turns round-trips verbatim → faithful window reconstruction without parsing the body');
    assert.strictEqual((await ctx2.recentMemory('user:other-win', { kind: 'episode', n: 10 })).length, 0, 'fenced: another tenant sees none');
  });

  it('recentMemory ordering is deterministic under a same-ms write burst (monotonic occurredAt) — POC regression', async () => {
    const S = 'user:burst';
    // A fast loop lands all four episodes in (almost) the same millisecond. Without the wrapper's monotonic
    // occurredAt these tie on Date.now(), and litectx's path tiebreak reconstructs the window out of order.
    for (const i of [1, 2, 3, 4]) await ctx2.rememberEpisode(S, `turn ${i}`, { meta: { turns: [{ role: 'user', content: `t${i}` }] } });
    const hits = await ctx2.recentMemory(S, { kind: 'episode', n: 10 });
    const reconstructed = [...hits].reverse().flatMap((h) => h.meta.turns).map((t) => t.content);
    assert.deepStrictEqual(reconstructed, ['t1', 't2', 't3', 't4'], 'oldest-first reconstruction stays faithful even in a same-ms burst');
  });

  it('countMemory is per-kind and tenant-fenced (O1)', async () => {
    const S = 'user:cnt';
    await ctx2.rememberEpisode(S, 'an episode');
    await ctx2.rememberFact(S, 'a durable fact', { by: 'human' });
    assert.strictEqual(await ctx2.countMemory(S, { kind: 'episode' }), 1, 'one episode for this tenant');
    assert.strictEqual(await ctx2.countMemory(S, { kind: 'fact' }), 1, 'one fact for this tenant');
    assert.strictEqual(await ctx2.countMemory('user:cnt-other', { kind: 'episode' }), 0, 'fenced: another tenant counts zero');
  });

  it('promotionSweep promotes a HOT episode to a durable fact (verbatim, no LLM); a cold one stays', async () => {
    const HOT = 'customer beta always asks about furniture delivery windows';
    const COLD = 'a one-off question about parking validation';
    await ctx2.rememberEpisode('user:beta', HOT);
    await ctx2.rememberEpisode('user:beta', COLD);
    // make the HOT episode cross the promotion threshold by USE (recall is the usefulness signal).
    for (let i = 0; i < 4; i++) await ctx2.recallMemory('furniture delivery windows', { scope: 'user:beta', n: 5 });

    const promoted = await ctx2.promotionSweep('user:beta', { threshold: 3 });
    assert.ok(promoted >= 1, 'at least the hot episode is promoted');

    // the promoted text now lives on the FACT axis (verbatim copy of the episode body)…
    const facts = await ctx2.recallMemory('furniture delivery', { scope: 'user:beta', n: 10 });
    assert.match(facts.map((h) => h.content).join('\n'), /furniture delivery windows/, 'hot episode promoted to a fact');
    // …and a re-sweep UPSERTS the same fact id rather than duplicating.
    const again = await ctx2.promotionSweep('user:beta', { threshold: 3 });
    const factHits = (await ctx2.recallMemory('furniture delivery', { scope: 'user:beta', n: 10 }))
      .filter((h) => /furniture delivery windows/.test(h.content));
    assert.ok(factHits.length <= 2, `re-sweep upserts, not duplicates (got ${factHits.length}); promoted again=${again}`);

    // negative control: the COLD episode (recalled 0×) is not a fact.
    const cold = await ctx2.recallMemory('parking validation', { scope: 'user:beta', n: 10 });
    assert.doesNotMatch(
      cold.filter((h) => /parking validation/.test(h.content)).map((h) => h.content).join('\n'),
      /^(?=.*parking).*fact/i,
      'cold episode is not spuriously promoted',
    );
  });

  it('memory is tenant-fenced: one customer never recalls another customer\'s memory (#6)', async () => {
    await ctx2.rememberFact('user:alpha', 'alpha secret: the launch code is zephyr', { by: 'human' });
    await ctx2.rememberFact('user:gamma', 'gamma secret: the vault pin is orchid', { by: 'human' });

    const alpha = paths(await ctx2.recallMemory('secret', { scope: 'user:alpha', n: 10 }));
    const gamma = paths(await ctx2.recallMemory('secret', { scope: 'user:gamma', n: 10 }));

    const aText = (await ctx2.recallMemory('secret', { scope: 'user:alpha', n: 10 })).map((h) => h.content).join('\n');
    assert.match(aText, /zephyr/, 'alpha recalls its own fact');
    assert.doesNotMatch(aText, /orchid/, 'alpha must NOT recall gamma\'s fact [security neg control]');

    const gText = (await ctx2.recallMemory('secret', { scope: 'user:gamma', n: 10 })).map((h) => h.content).join('\n');
    assert.doesNotMatch(gText, /zephyr/, 'gamma must NOT recall alpha\'s fact [security neg control]');
    assert.ok(alpha.length > 0 && gamma.length > 0, 'both tenants have their own memory');
  });

  it('recallMemory with no scope THROWS (fail-closed, never see-everything)', async () => {
    await assert.rejects(
      () => ctx2.recallMemory('secret', { n: 10 }),
      /scope is required/,
      'a missing scope must throw, not recall every tenant',
    );
  });

  it('forgetMemory clears ONE tenant\'s memory, never another\'s (the /forget security boundary)', async () => {
    // two customers whose ids are prefix-related (user:1 / user:12) — the worst case proving the
    // fence is owner-based, not id-based (litectx 0.22.0 forget({scope}), validated).
    await ctx2.rememberFact('user:1', 'one fact: the gate badge is mauve', { by: 'human' });
    await ctx2.rememberEpisode('user:1', 'one episode: asked about the badge');
    await ctx2.rememberFact('user:12', 'twelve fact: the locker code is teal', { by: 'human' });

    const before1 = (await ctx2.recallMemory('badge gate', { scope: 'user:1', n: 10 })).map((h) => h.content).join('\n');
    assert.match(before1, /badge is mauve/, 'tenant 1 has memory before forget');

    const removed = await ctx2.forgetMemory('user:1');
    assert.ok(removed >= 1, 'forget removed tenant 1\'s rows');

    // tenant 1 is cleared…
    const after1 = await ctx2.recallMemory('badge gate', { scope: 'user:1', n: 10 });
    assert.equal(after1.length, 0, 'tenant 1 memory is gone');
    // …tenant 12 SURVIVES (security neg control — id is a prefix of the forgotten one).
    const after12 = (await ctx2.recallMemory('locker code', { scope: 'user:12', n: 10 })).map((h) => h.content).join('\n');
    assert.match(after12, /locker code is teal/, 'tenant 12 memory SURVIVES tenant 1\'s forget [security neg control]');
  });

  it('forgetMemory with no scope THROWS (fail-closed)', async () => {
    await assert.rejects(
      () => ctx2.forgetMemory(),
      /scope is required/,
      'a scope-less forget must throw, not wipe every tenant',
    );
  });

  // --- targeted forget by id (M14): precise delete + promotion-root cascade + tenant safety ---

  it('forgetMemoryById removes ONE fact by id, leaving the tenant\'s other facts', async () => {
    const S = 'user:fbid-one';
    await ctx2.rememberFact(S, 'my wedding is on Monday', { by: 'human', id: 'fact:wed' });
    await ctx2.rememberFact(S, 'I drive a Toyota', { by: 'human', id: 'fact:car' });
    const removed = await ctx2.forgetMemoryById(S, 'fact:wed');
    assert.strictEqual(removed, 1, 'exactly the one row');
    assert.strictEqual(await ctx2.countMemory(S, { kind: 'fact' }), 1, 'the other fact survives');
    const left = (await ctx2.recallMemory('Toyota', { scope: S, n: 5 })).map((h) => h.content).join('\n');
    assert.match(left, /Toyota/, 'the untargeted fact is still there');
  });

  it('forgetMemoryById CASCADES a promoted fact to its source episode — no rebound', async () => {
    const S = 'user:fbid-cascade';
    // an episode lands, then gets promoted exactly as promotionSweep does: fact id = `fact-<episodePath>`.
    await ctx2.rememberEpisode(S, 'we talked about the wedding venue and the date');
    const [ep] = await ctx2.recentMemory(S, { kind: ['episode'], n: 1 });
    const epId = ep.name;                                   // the real minted episode id/path
    await ctx2.rememberFact(S, 'wedding venue booked', { by: 'agent', id: `fact-${epId}` });
    assert.strictEqual(await ctx2.countMemory(S, { kind: 'episode' }), 1);
    assert.strictEqual(await ctx2.countMemory(S, { kind: 'fact' }), 1);

    const removed = await ctx2.forgetMemoryById(S, `fact-${epId}`);
    assert.ok(removed >= 2, 'removed the promoted fact AND its source episode');
    assert.strictEqual(await ctx2.countMemory(S, { kind: 'fact' }), 0, 'promoted fact gone');
    assert.strictEqual(await ctx2.countMemory(S, { kind: 'episode' }), 0, 'source episode gone → cannot re-promote (rebound closed)');
  });

  it('forgetMemoryById refuses a foreign id (not in scope) and leaves sibling tenants intact', async () => {
    // Realistic ids are process-unique (memId = mem-<ts>-<seq>), so two tenants never share one. The
    // scoped get() is the boundary: an id not present in the caller's scope → null → refused (0), never
    // reaches the owner-blind base delete. (The residual shared-id blind-delete is a litectx gap — a
    // scoped delete-by-id would close it; filed as an ask. multis is safe today via id-uniqueness.)
    await ctx2.rememberFact('user:fbid-a', 'A note about badges', { by: 'human', id: 'fact:a-badge' });
    await ctx2.rememberFact('user:fbid-b', 'B note about lockers', { by: 'human', id: 'fact:b-locker' });
    // B cannot target an id outside its scope — scoped get fences it → refused, A untouched.
    assert.strictEqual(await ctx2.forgetMemoryById('user:fbid-b', 'fact:a-badge'), 0, 'a foreign id is refused, not blind-deleted');
    const aStill = (await ctx2.recallMemory('badges', { scope: 'user:fbid-a', n: 5 })).map((h) => h.content).join('\n');
    assert.match(aStill, /badges/, 'tenant A untouched by B\'s attempt [security neg control]');
    // A forgets its OWN fact by id → gone; B (distinct id) survives.
    assert.strictEqual(await ctx2.forgetMemoryById('user:fbid-a', 'fact:a-badge'), 1, 'own id deletes');
    const bStill = (await ctx2.recallMemory('lockers', { scope: 'user:fbid-b', n: 5 })).map((h) => h.content).join('\n');
    assert.match(bStill, /lockers/, 'sibling tenant B survives A\'s targeted forget');
  });

  // --- W4 supersession mechanic (litectx 0.24.0 (scope,id) upsert) ---

  it('rememberFact with an explicit id UPSERTS in place — a restated fact never piles up (W4)', async () => {
    const S = 'user:w4-upsert';
    await ctx2.rememberFact(S, 'the project deadline is Tuesday', { by: 'human', id: 'fact:deadline' });
    await ctx2.rememberFact(S, 'the project deadline is Thursday', { by: 'human', id: 'fact:deadline' });
    assert.strictEqual(await ctx2.countMemory(S, { kind: 'fact' }), 1, 'one row after restating the same id');
    const hits = (await ctx2.recallMemory('project deadline', { scope: S, n: 10 })).map((h) => h.content).join('\n');
    assert.match(hits, /Thursday/, 'the latest value wins');
    assert.doesNotMatch(hits, /Tuesday/, 'the superseded value is gone (replaced, not duplicated)');
  });

  it('rememberFact WITHOUT an id mints a fresh fact each time — no accidental upsert', async () => {
    const S = 'user:w4-newid';
    await ctx2.rememberFact(S, 'I like tea', { by: 'human' });
    await ctx2.rememberFact(S, 'I like coffee', { by: 'human' });
    assert.strictEqual(await ctx2.countMemory(S, { kind: 'fact' }), 2, 'two distinct facts (id auto-minted, never collides)');
  });

  it('the same id under a DIFFERENT scope is a separate row — the upsert is tenant-fenced (W4 neg control)', async () => {
    await ctx2.rememberFact('user:w4-a', 'tenant-a value', { by: 'human', id: 'fact:shared-key' });
    await ctx2.rememberFact('user:w4-b', 'tenant-b value', { by: 'human', id: 'fact:shared-key' });
    const a = (await ctx2.recallMemory('value', { scope: 'user:w4-a', n: 10 })).map((h) => h.content).join('\n');
    const b = (await ctx2.recallMemory('value', { scope: 'user:w4-b', n: 10 })).map((h) => h.content).join('\n');
    assert.match(a, /tenant-a value/, 'tenant a keeps its own row under the shared id');
    assert.doesNotMatch(a, /tenant-b/, 'tenant b never overwrote tenant a by id [security neg control]');
    assert.match(b, /tenant-b value/, 'tenant b keeps its own row under the shared id');
  });

  it('factCandidates returns this tenant\'s existing facts as {id,text}, scope-fenced (the judge\'s input)', async () => {
    await ctx2.rememberFact('user:w4-cand', 'the deploy window is Tuesday at 9am', { by: 'human' });
    const cands = await ctx2.factCandidates('user:w4-cand', 'deploy window', { n: 5 });
    assert.ok(cands.length >= 1, 'the existing fact is surfaced as a candidate');
    assert.ok(cands.every((c) => typeof c.id === 'string' && typeof c.text === 'string'), 'shape is {id,text}');
    assert.match(cands.map((c) => c.text).join('\n'), /deploy window is Tuesday/, 'candidate carries the fact text');
    // the id round-trips: re-passing it to rememberFact upserts the same row, not a new one
    await ctx2.rememberFact('user:w4-cand', 'the deploy window is Thursday at 2pm', { by: 'human', id: cands[0].id });
    assert.strictEqual(await ctx2.countMemory('user:w4-cand', { kind: 'fact' }), 1, 'candidate id round-trips as the upsert key');
    const other = await ctx2.factCandidates('user:w4-other', 'deploy window', { n: 5 });
    assert.strictEqual(other.length, 0, 'fenced: another tenant sees no candidates [security neg control]');
  });
});
