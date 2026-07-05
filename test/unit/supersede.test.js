'use strict';
/**
 * Unit tests for src/memory/supersede.js — the W4 same-subject supersession judge + orchestration.
 *
 * Deterministic: a FAKE provider stands in for the LLM (the judge's QUALITY on real prose is
 * characterized by a real_api POC, not re-run here). These lock the safety contract that wraps the
 * judgment: fail toward KEEPING (never overwrite on uncertainty/error), validate the model's choice
 * against the candidate list (no hallucinated/out-of-range id reaches the write), the graceful
 * degrade to a plain new-fact write when superseding is off / no provider / recall fails, and that
 * an overwrite reports the prior value (supersededText) for the "tell-me" reply.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { resolveSupersedeId, rememberWithSupersede, parseChoice } = require('../../src/memory/supersede');

// bare-agent provider shape: generate(messages, tools, opts) → { text }. simpleGenerate unwraps .text.
const fakeProvider = (reply) => ({ generate: async () => ({ text: reply }) });
const throwingProvider = () => ({ generate: async () => { throw new Error('LLM down'); } });
const CANDS = [{ id: 'fact:a', text: 'deadline is Tuesday' }, { id: 'fact:b', text: 'likes coffee' }];

describe('parseChoice', () => {
  it('UPDATE <n> → the index', () => assert.strictEqual(parseChoice('UPDATE 2'), 2));
  it('reads a bare number too (tolerant)', () => assert.strictEqual(parseChoice('1'), 1));
  it('NEW → null', () => assert.strictEqual(parseChoice('NEW'), null));
  it('NEW wins a tie over a stray digit → null (fail-toward-keep, no false-merge)', () => assert.strictEqual(parseChoice('NEW, not 1'), null));
  it('empty → null', () => assert.strictEqual(parseChoice(''), null));
  it('non-numeric garbage → null (fail safe, treated as keep)', () => assert.strictEqual(parseChoice('maybe?'), null));
});

describe('resolveSupersedeId', () => {
  it('returns the chosen candidate id when the judge picks UPDATE <n>', async () => {
    assert.strictEqual(await resolveSupersedeId({ provider: fakeProvider('UPDATE 1'), candidates: CANDS, note: 'deadline is Friday' }), 'fact:a');
    assert.strictEqual(await resolveSupersedeId({ provider: fakeProvider('UPDATE 2'), candidates: CANDS, note: 'loves espresso' }), 'fact:b');
  });

  it('returns null when the judge answers NEW', async () => {
    assert.strictEqual(await resolveSupersedeId({ provider: fakeProvider('NEW'), candidates: CANDS, note: 'I drive a Tesla' }), null);
  });

  it('rejects an OUT-OF-RANGE (hallucinated) number → null, never a bad overwrite', async () => {
    assert.strictEqual(await resolveSupersedeId({ provider: fakeProvider('UPDATE 99'), candidates: CANDS, note: 'x' }), null);
    assert.strictEqual(await resolveSupersedeId({ provider: fakeProvider('UPDATE 0'), candidates: CANDS, note: 'x' }), null);
  });

  it('empty candidates → null without calling the LLM', async () => {
    let called = false;
    const spy = { generate: async () => { called = true; return { text: 'UPDATE 1' }; } };
    assert.strictEqual(await resolveSupersedeId({ provider: spy, candidates: [], note: 'x' }), null);
    assert.strictEqual(called, false, 'no LLM call when there is nothing to supersede');
  });

  it('missing provider → null', async () => {
    assert.strictEqual(await resolveSupersedeId({ provider: null, candidates: CANDS, note: 'x' }), null);
  });

  it('LLM error → null (fail toward keeping, never destroy)', async () => {
    assert.strictEqual(await resolveSupersedeId({ provider: throwingProvider(), candidates: CANDS, note: 'x' }), null);
  });
});

describe('rememberWithSupersede', () => {
  // a fake indexer recording the write; factCandidates returns a fixed set
  const makeIndexer = (candidates = CANDS) => {
    const calls = { fact: [], candidates: [] };
    return {
      calls,
      factCandidates: async (scope, note, opts) => { calls.candidates.push({ scope, note, opts }); return candidates; },
      rememberFact: async (scope, note, opts) => { calls.fact.push({ scope, note, opts }); },
    };
  };

  it('superseding OFF → a plain new fact, no candidate fetch, no judge', async () => {
    const ix = makeIndexer();
    const r = await rememberWithSupersede({ indexer: ix, provider: fakeProvider('UPDATE 1'), scope: 'admin', note: 'n', memCfg: { supersede: false } });
    assert.deepStrictEqual(r, { id: null, superseded: false, supersededText: null });
    assert.strictEqual(ix.calls.candidates.length, 0, 'no candidate fetch when off');
    assert.strictEqual(ix.calls.fact.length, 1);
    assert.strictEqual(ix.calls.fact[0].opts.id, null, 'a new fact (null id → memId, no upsert)');
    assert.strictEqual(ix.calls.fact[0].opts.by, 'human');
  });

  it('no provider → degrades to a plain new fact (judge is strictly additive)', async () => {
    const ix = makeIndexer();
    const r = await rememberWithSupersede({ indexer: ix, provider: null, scope: 'admin', note: 'n', memCfg: {} });
    assert.deepStrictEqual(r, { id: null, superseded: false, supersededText: null });
    assert.strictEqual(ix.calls.candidates.length, 0);
    assert.strictEqual(ix.calls.fact[0].opts.id, null);
  });

  it('judge picks a candidate → UPSERTS that id and reports the prior value (supersededText)', async () => {
    const ix = makeIndexer();
    const r = await rememberWithSupersede({ indexer: ix, provider: fakeProvider('UPDATE 1'), scope: 'admin', note: 'deadline is Friday', memCfg: {} });
    assert.deepStrictEqual(r, { id: 'fact:a', superseded: true, supersededText: 'deadline is Tuesday' });
    assert.strictEqual(ix.calls.fact[0].opts.id, 'fact:a', 'writes under the superseded id (overwrite in place)');
  });

  it('re-saving an IDENTICAL fact upserts the same id but reports no change (supersededText null → plain "Noted.")', async () => {
    const ix = makeIndexer([{ id: 'fact:a', text: 'my wedding on Wednesday' }]);
    const r = await rememberWithSupersede({ indexer: ix, provider: fakeProvider('UPDATE 1'), scope: 'admin', note: 'my wedding on Wednesday', memCfg: {} });
    assert.deepStrictEqual(r, { id: 'fact:a', superseded: true, supersededText: null });
    assert.strictEqual(ix.calls.fact[0].opts.id, 'fact:a', 'still upserts the same id (no duplicate row)');
  });

  it('judge says NEW → a new fact (no id), superseded:false, no prior value', async () => {
    const ix = makeIndexer();
    const r = await rememberWithSupersede({ indexer: ix, provider: fakeProvider('NEW'), scope: 'admin', note: 'unrelated', memCfg: {} });
    assert.deepStrictEqual(r, { id: null, superseded: false, supersededText: null });
    assert.strictEqual(ix.calls.fact[0].opts.id, null, 'a brand-new fact');
  });

  it('no existing candidates → new fact without an LLM call', async () => {
    const ix = makeIndexer([]);
    let called = false;
    const spy = { generate: async () => { called = true; return { text: 'UPDATE 1' }; } };
    const r = await rememberWithSupersede({ indexer: ix, provider: spy, scope: 'admin', note: 'first ever', memCfg: {} });
    assert.deepStrictEqual(r, { id: null, superseded: false, supersededText: null });
    assert.strictEqual(called, false, 'empty candidate set short-circuits the judge');
    assert.strictEqual(ix.calls.fact[0].opts.id, null);
  });

  it('a factCandidates failure degrades to a plain new fact — the note is NEVER lost (fail-toward-keep)', async () => {
    const calls = { fact: [] };
    const ix = {
      calls,
      factCandidates: async () => { throw new Error('recall backend down'); },
      rememberFact: async (scope, note, opts) => { calls.fact.push({ scope, note, opts }); },
    };
    const r = await rememberWithSupersede({ indexer: ix, provider: fakeProvider('UPDATE 1'), scope: 'admin', note: 'keep me', memCfg: {} });
    assert.deepStrictEqual(r, { id: null, superseded: false, supersededText: null });
    assert.strictEqual(calls.fact.length, 1, 'the note is still written despite the recall failure');
    assert.strictEqual(calls.fact[0].note, 'keep me');
    assert.strictEqual(calls.fact[0].opts.id, null, 'written as a plain new fact (no upsert)');
  });

  it('honors supersede_candidates as the candidate count', async () => {
    const ix = makeIndexer();
    await rememberWithSupersede({ indexer: ix, provider: fakeProvider('NEW'), scope: 'admin', note: 'n', memCfg: { supersede_candidates: 3 } });
    assert.strictEqual(ix.calls.candidates[0].opts.n, 3);
  });
});

// M13 supersede pre-check — the cosine gate that skips the LLM judge for clearly-unrelated notes.
// Candidates carry a `sim` field ONLY in semantic mode (the context wrapper attaches it). These lock
// the gate's contract: below the threshold → NO LLM call (write NEW); at/above → the judge runs as
// before; the threshold is config-tunable; and BM25-mode candidates (no `sim`) leave the judge intact.
describe('rememberWithSupersede — M13 pre-check', () => {
  // an LLM spy: records whether the judge was called, and answers UPDATE 1 if it ever is (so a missing
  // skip would visibly overwrite — the test can't pass by accident).
  const spyProvider = () => { const s = { called: false }; s.generate = async () => { s.called = true; return { text: 'UPDATE 1' }; }; return s; };
  const makeIndexer = (candidates) => {
    const calls = { fact: [] };
    return { calls, factCandidates: async () => candidates, rememberFact: async (scope, note, opts) => { calls.fact.push({ scope, note, opts }); } };
  };

  it('closest fact BELOW threshold → skips the LLM entirely, writes a NEW fact, logs the skip', async () => {
    const ix = makeIndexer([{ id: 'fact:a', text: 'my wedding is on Monday', sim: 0.12 }]);
    const llm = spyProvider();
    const logs = [];
    const r = await rememberWithSupersede({ indexer: ix, provider: llm, scope: 'admin', note: 'the printer is out of ink', memCfg: {}, audit: (e) => logs.push(e) });
    assert.strictEqual(llm.called, false, 'a note far from every fact never reaches the judge');
    assert.deepStrictEqual(r, { id: null, superseded: false, supersededText: null }, 'written as a plain new fact');
    assert.strictEqual(ix.calls.fact[0].opts.id, null);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].decision, 'skip');
    assert.strictEqual(logs[0].topSim, 0.12);
  });

  it('closest fact AT/ABOVE threshold → the judge runs (a real restatement is NOT skipped)', async () => {
    // 0.49 = the paraphrased-update tail from the broad POC ("electrician" vs "plumber") — the exact
    // case that MUST fall through, or M13 reintroduces the duplicate bug M4 fixed.
    const ix = makeIndexer([{ id: 'fact:a', text: 'I work as a plumber', sim: 0.49 }]);
    const llm = spyProvider();
    const logs = [];
    const r = await rememberWithSupersede({ indexer: ix, provider: llm, scope: 'admin', note: 'I am an electrician now', memCfg: {}, audit: (e) => logs.push(e) });
    assert.strictEqual(llm.called, true, 'a close note reaches the judge');
    assert.strictEqual(r.id, 'fact:a', 'the judge supersedes it');
    assert.strictEqual(logs[0].decision, 'update');
  });

  it('uses the MAX sim across candidates — one close fact defeats the skip', async () => {
    const ix = makeIndexer([
      { id: 'fact:a', text: 'far thing', sim: 0.05 },
      { id: 'fact:b', text: 'close thing', sim: 0.62 },
    ]);
    const llm = spyProvider();
    await rememberWithSupersede({ indexer: ix, provider: llm, scope: 'admin', note: 'n', memCfg: {}, audit: () => {} });
    assert.strictEqual(llm.called, true, 'the single close candidate forces the judge to run');
  });

  it('a custom supersede_threshold moves the gate', async () => {
    const ix = makeIndexer([{ id: 'fact:a', text: 't', sim: 0.40 }]);
    const llm = spyProvider();
    // 0.40 < 0.55 → below a raised threshold → skip
    await rememberWithSupersede({ indexer: ix, provider: llm, scope: 'admin', note: 'n', memCfg: { supersede_threshold: 0.55 }, audit: () => {} });
    assert.strictEqual(llm.called, false, 'raising the threshold skips a formerly-judged note');
  });

  it('candidates WITHOUT sim (BM25-only mode) → pre-check inert, judge runs, nothing logged', async () => {
    const ix = makeIndexer([{ id: 'fact:a', text: 'deadline Tuesday' }]); // no sim field
    const llm = spyProvider();
    const logs = [];
    await rememberWithSupersede({ indexer: ix, provider: llm, scope: 'admin', note: 'deadline Friday', memCfg: {}, audit: (e) => logs.push(e) });
    assert.strictEqual(llm.called, true, 'no sim → the pre-check cannot fire → the judge runs as before');
    assert.strictEqual(logs.length, 0, 'no pre-check decision logged when inactive (BM25 path stays I/O-free)');
  });
});
