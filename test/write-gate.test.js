const { describe, it } = require('node:test');
const assert = require('node:assert');

const { makeWriteGate } = require('../src/security/write-gate');
const { RateLimiter } = require('../src/security/rate-limit');

// Injectable clock so windows are deterministic (mirrors rate-limit.test.js).
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

// litectx emits this shape to writeGate.check(); meta is the opaque caller dict
// (multis puts `writer` on CUSTOMER episode writes only — see rememberEpisodeFor).
const custWrite = (writer, i = 0) => ({ type: 'memory.write', kind: 'episode', provenance: 'agent', text: `m${i}`, id: `e${i}`, meta: { writer } });
const ownerWrite = (i = 0) => ({ type: 'memory.write', kind: 'fact', provenance: 'human', text: `f${i}`, id: `f${i}` }); // no meta.writer

describe('makeWriteGate', () => {
  it('#2 bounds a customer writer at the cap, then denies', async () => {
    const now = fakeClock();
    const limiter = new RateLimiter({ burstPerMin: 0, dailyPerSender: 3, now });
    const gate = makeWriteGate({ limiter });
    const out = [];
    for (let i = 0; i < 5; i++) out.push((await gate.check(custWrite('user:cust1', i))).outcome);
    assert.deepStrictEqual(out, ['allow', 'allow', 'allow', 'deny', 'deny']);
  });

  it('#2 NEVER throttles an owner/exempt write (no meta.writer) even past the cap', async () => {
    const now = fakeClock();
    const limiter = new RateLimiter({ burstPerMin: 0, dailyPerSender: 3, now });
    const gate = makeWriteGate({ limiter });
    for (let i = 0; i < 10; i++) {
      const d = await gate.check(ownerWrite(i));
      assert.strictEqual(d.outcome, 'allow');
    }
  });

  it('counts each writer independently (one spammer does not block another)', async () => {
    const now = fakeClock();
    const limiter = new RateLimiter({ burstPerMin: 0, dailyPerSender: 2, now });
    const gate = makeWriteGate({ limiter });
    await gate.check(custWrite('user:a'));
    await gate.check(custWrite('user:a'));
    assert.strictEqual((await gate.check(custWrite('user:a'))).outcome, 'deny'); // a exhausted
    assert.strictEqual((await gate.check(custWrite('user:b'))).outcome, 'allow'); // b untouched
  });

  it('audits a denied write once (single choke point), with chat + scope', async () => {
    const now = fakeClock();
    const limiter = new RateLimiter({ burstPerMin: 0, dailyPerSender: 1, now });
    const lines = [];
    const gate = makeWriteGate({ limiter, audit: (e) => lines.push(e) });
    await gate.check(custWrite('user:cust1'));            // allowed → no audit
    await gate.check(custWrite('user:cust1'));            // denied → audit
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].action, 'write_denied');
    assert.strictEqual(lines[0].chatId, 'user:cust1');
    assert.strictEqual(lines[0].scope, 'daily');
  });

  it('is inert (allows all) when no limiter is wired', async () => {
    const gate = makeWriteGate({});
    for (let i = 0; i < 5; i++) assert.strictEqual((await gate.check(custWrite('user:x', i))).outcome, 'allow');
  });
});

// Integration: the gate wired into the REAL litectx store via multis's context
// wrapper — proves meta.writer reaches the gate, a deny is a real WriteDeniedError
// thrown BEFORE commit, and the denied row is not persisted. (embeddings:false →
// deterministic, no model load.) Mirrors the shape rememberEpisodeFor emits.
describe('writeGate ⨯ real litectx store', () => {
  const os = require('os'), fs = require('fs'), path = require('path');
  const { setMultisDir } = require('../src/config');

  it('bounds a customer scope, exempts the owner, and a deny is an uncommitted WriteDeniedError', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-int-'));
    setMultisDir(tmp);
    // Fresh require so the context singleton binds THIS temp dir.
    delete require.cache[require.resolve('../src/context/index')];
    const ctx = require('../src/context/index');
    const gate = makeWriteGate({ limiter: new RateLimiter({ burstPerMin: 0, dailyPerSender: 3 }) });
    await ctx.init({ embeddings: false, writeGate: gate });

    // Customer writes carry meta.writer (per rememberEpisodeFor); cap is 3.
    let denied = null;
    for (let i = 0; i < 6; i++) {
      try { await ctx.rememberEpisode('user:cust1', `m${i}`, { meta: { writer: 'user:cust1' } }); }
      catch (e) { denied = e; }
    }
    assert.ok(denied, 'a write past the cap must throw');
    assert.strictEqual(denied.name, 'WriteDeniedError', 'the swallow-guard duck-types on this exact name');
    assert.strictEqual(await ctx.countMemory('user:cust1', { kind: 'episode' }), 3, 'only the allowed writes committed');

    // Owner writes omit meta.writer → never throttled.
    for (let i = 0; i < 6; i++) await ctx.rememberFact('admin', `owner ${i}`, { by: 'human' });
    assert.strictEqual(await ctx.countMemory('admin', { kind: 'fact' }), 6, 'owner is exempt past the cap');

    await ctx.purge?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // DELIVERY proof: drive the REAL handler path (silent capture → rememberEpisodeFor),
  // NOT setting meta.writer ourselves. If rememberEpisodeFor fails to stamp `writer`
  // for a customer, the customer would be exempt and this bounds-check fails — this is
  // the mutation guard the M5 lesson demands (a seam test that survives glue mutation
  // has not validated delivery).
  it('bounds a customer through createMessageRouter but never the owner', async () => {
    const { createMessageRouter } = require('../src/bot/handlers');
    const { createTestEnv, mockPlatform, msg } = require('./helpers/setup');
    const env = createTestEnv({ allowed_users: ['owner1'], owner_id: 'owner1' });
    // Fresh context bound to this env's temp dir, wired with a low-cap write gate.
    delete require.cache[require.resolve('../src/context/index')];
    const ctx = require('../src/context/index');
    await ctx.init({ embeddings: false, writeGate: makeWriteGate({ limiter: new RateLimiter({ burstPerMin: 0, dailyPerSender: 3 }) }) });

    const router = createMessageRouter(env.config, { indexer: ctx, memoryBaseDir: env.memoryBaseDir });
    const platform = mockPlatform();

    // 6 CUSTOMER messages in silent mode — meta.writer must be stamped by rememberEpisodeFor.
    for (let i = 0; i < 6; i++) {
      await router(msg(`spam ${i}`, { routeAs: 'silent', senderId: 'cust1', chatId: 'chatCust', isSelf: false }), platform);
    }
    // 6 OWNER messages in silent mode — no writer stamped → exempt.
    for (let i = 0; i < 6; i++) {
      await router(msg(`note ${i}`, { routeAs: 'silent', senderId: 'owner1', chatId: 'chatOwner', isSelf: true }), platform);
    }

    assert.strictEqual(await ctx.countMemory('user:chatCust', { kind: 'episode' }), 3, 'customer bounded at the cap via the real path');
    assert.strictEqual(await ctx.countMemory('admin', { kind: 'episode' }), 6, 'owner never throttled');

    await ctx.purge?.();
    env.cleanup();
  });
});
