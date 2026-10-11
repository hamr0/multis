'use strict';
/**
 * Integration test: targeted /forget with litectx EMBEDDINGS ON (the production default,
 * config.memory.semantic:true). The rest of the suite is BM25-only, so nothing else exercises the
 * `keyword` flag (litectx 0.35.0) that /forget's relevance filter depends on in semantic mode.
 *
 * Runs against the INSTALLED litectx with the real embedder (always-on; ~2s model load, cached) and
 * the REAL factCandidates + /forget handler — no mocked indexer. Guards against a litectx that stops
 * emitting `keyword` with embeddings on: every hit would map to keyword:false and /forget would
 * silently drop an exact-word fact whose cosine is below the 0.30 threshold.
 *
 * Own file on purpose: src/context holds a process-wide singleton and `node --test` isolates files.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { createMessageRouter } = require('../../src/bot/handlers');
const { hashPin, PinManager } = require('../../src/security/pin');
const { PendingRegistry } = require('../../src/bot/pending');
const { createTestEnv, mockPlatform, mockLLM, msg } = require('../helpers/setup');

const THRESHOLD = 0.30; // config.memory.forget_match_threshold default
const EXACT_HIGH = 'the unicorn costume is in the attic box';
const EXACT_LOW = 'invoice 4471 line item: refurbished unicorn-brand office chair, qty 1'; // cosine ~0.23 < THRESHOLD
const NOISE = ['remember to buy oat milk and coffee beans', 'dentist appointment next Tuesday at 3pm'];

describe('/forget with embeddings on (real litectx, real handler)', () => {
  let env, context;

  before(async () => {
    env = createTestEnv({
      allowed_users: ['user1'], owner_id: 'user1',
      security: { pin_hash: hashPin('1234'), pin_timeout_hours: 24, checkpoint_tools: [] },
    });
    // require AFTER createTestEnv (it points the config module at a temp dir) so the DB lives there.
    context = require('../../src/context');
    await context.init({ documents: {}, embeddings: true });
    for (const t of [EXACT_HIGH, EXACT_LOW, ...NOISE]) await context.rememberFact('admin', t);
  });

  after(() => { if (env) env.cleanup(); });

  it('factCandidates reports keyword:true for exact-word facts, keyword:false for meaning-only, and a numeric sim', async () => {
    const cands = await context.factCandidates('admin', 'unicorn', { n: 8 });
    for (const c of cands) {
      assert.equal(typeof c.keyword, 'boolean', `keyword is a boolean on "${c.text}"`);
      assert.equal(typeof c.sim, 'number', `sim (cosine) is present in embeddings mode on "${c.text}"`);
    }
    const by = (text) => cands.find((c) => c.text === text);
    assert.ok(by(EXACT_HIGH) && by(EXACT_LOW), 'both exact-word facts are returned');
    assert.equal(by(EXACT_HIGH).keyword, true, 'exact word → keyword:true');
    assert.equal(by(EXACT_LOW).keyword, true, 'exact word with LOW cosine → still keyword:true');
    for (const t of NOISE) if (by(t)) assert.equal(by(t).keyword, false, `meaning-only nominee "${t}" → keyword:false`);
    assert.ok(by(EXACT_LOW).sim < THRESHOLD, `fixture no longer exercises the low-cosine case (sim=${by(EXACT_LOW).sim})`);
  });

  it('/forget unicorn offers BOTH exact-word facts (incl. the low-cosine one) and never the KNN noise', async () => {
    const platform = mockPlatform();
    const pinManager = new PinManager(env.config);
    pinManager.sessions = {};
    const router = createMessageRouter(env.config, {
      llm: mockLLM(), indexer: context, pinManager, pending: new PendingRegistry(), fileless: true,
      governanceFile: { commands: { allowlist: ['.*'], denylist: [] }, paths: { allowed: ['.*'], denied: [] } },
      memoryBaseDir: env.memoryBaseDir,
    });
    router.registerPlatform('telegram', platform);
    await router(msg('/forget unicorn'), platform);
    const picker = platform.sent.at(-1).text;
    assert.ok(picker.includes(EXACT_HIGH), 'the high-cosine exact-word fact is offered');
    assert.ok(picker.includes(EXACT_LOW), 'the low-cosine exact-word fact is offered (keyword clause)');
    for (const t of NOISE) assert.ok(!picker.includes(t), `KNN noise "${t}" is not offered`);
    assert.equal(await context.countMemory('admin', { kind: 'fact' }), 4, 'listing is read-only');
  });
});
