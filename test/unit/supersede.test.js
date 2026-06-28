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
