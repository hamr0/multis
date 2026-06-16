const { describe, it } = require('node:test');
const assert = require('node:assert');

const { RateLimiter } = require('../src/security/rate-limit');

// Injectable clock so windows are deterministic.
function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

describe('RateLimiter', () => {
  it('allows up to burstPerMin then blocks within the minute', () => {
    const now = fakeClock();
    const rl = new RateLimiter({ burstPerMin: 3, dailyPerSender: 100, now });
    assert.strictEqual(rl.consume('a').allowed, true);
    assert.strictEqual(rl.consume('a').allowed, true);
    assert.strictEqual(rl.consume('a').allowed, true);
    const blocked = rl.consume('a');
    assert.strictEqual(blocked.allowed, false);
    assert.strictEqual(blocked.scope, 'burst');
  });

  it('burst window rolls — slots free up after 60s', () => {
    const now = fakeClock();
    const rl = new RateLimiter({ burstPerMin: 2, dailyPerSender: 100, now });
    rl.consume('a'); rl.consume('a');
    assert.strictEqual(rl.consume('a').allowed, false);
    now.advance(61_000);
    assert.strictEqual(rl.consume('a').allowed, true, 'old hits aged out');
  });

  it('enforces the daily cap independent of burst', () => {
    const now = fakeClock();
    const rl = new RateLimiter({ burstPerMin: 1000, dailyPerSender: 5, now });
    for (let i = 0; i < 5; i++) {
      now.advance(120_000); // spread out so burst never trips
      assert.strictEqual(rl.consume('a').allowed, true);
    }
    now.advance(120_000);
    const v = rl.consume('a');
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.scope, 'daily');
  });

  it('limits are per-sender, not global', () => {
    const now = fakeClock();
    const rl = new RateLimiter({ burstPerMin: 1, dailyPerSender: 100, now });
    assert.strictEqual(rl.consume('a').allowed, true);
    assert.strictEqual(rl.consume('a').allowed, false);
    assert.strictEqual(rl.consume('b').allowed, true, 'sender b unaffected by a');
  });

  it('notify fires once per block streak, re-arms after an allowed message', () => {
    const now = fakeClock();
    const rl = new RateLimiter({ burstPerMin: 1, dailyPerSender: 100, now });
    rl.consume('a'); // allowed
    assert.strictEqual(rl.consume('a').notify, true, 'first block notifies');
    assert.strictEqual(rl.consume('a').notify, false, 'subsequent blocks stay quiet');
    now.advance(61_000);
    assert.strictEqual(rl.consume('a').allowed, true, 're-arm: an allowed message clears the streak');
    // the single burst slot is full again → next block re-notifies
    const v = rl.consume('a');
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.notify, true, 'notify re-arms after an allowed message');
  });

  it('a zero limit disables that window', () => {
    const now = fakeClock();
    const rl = new RateLimiter({ burstPerMin: 0, dailyPerSender: 0, now });
    for (let i = 0; i < 50; i++) assert.strictEqual(rl.consume('a').allowed, true);
  });

  // Security regression: without eviction the per-sender map grows once per
  // distinct senderId forever (business mode = any stranger). A size-triggered
  // sweep must drop senders whose every hit has aged out.
  it('evicts fully-aged senders once the sweep threshold is crossed', () => {
    const now = fakeClock();
    const rl = new RateLimiter({ burstPerMin: 5, dailyPerSender: 100, now });
    rl._sweepAt = 3; // shrink so the test doesn't need 5000 senders
    rl.consume('a'); rl.consume('b'); rl.consume('c');
    assert.strictEqual(rl._hits.size, 3);
    now.advance(86_400_001); // every existing hit ages out of the 24h window
    rl.consume('d');          // size (3) >= sweepAt → sweep runs before 'd'
    assert.strictEqual(rl._hits.has('a'), false, 'aged sender evicted');
    assert.strictEqual(rl._hits.has('b'), false);
    assert.strictEqual(rl._hits.has('c'), false);
    assert.ok(rl._hits.has('d'), 'active sender retained');
  });
});
