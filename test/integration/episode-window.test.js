'use strict';
/**
 * Integration test for the episode retention+promotion window wiring (litectx 0.25.0).
 *
 * Proves multis's `context.init({ episodeWindowDays })` actually reaches the LiteCtx constructor:
 * with a 90-day window, an episode aged 45 days survives the write-time prune that litectx's 30-day
 * DEFAULT would remove. If the wiring were broken (window not threaded → litectx falls back to 30),
 * the 45-day episode would prune and this test fails — so it's a real wiring check, not a tautology.
 *
 * The episode is aged via the raw LiteCtx handle (`context.raw()`) because the wrapper stamps
 * `occurredAt ≈ now`; aging through the configured instance is precisely what proves the config took.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 86400000;

describe('episode window (litectx 0.25.0 episodeWindowDays wiring)', () => {
  let context, tmp;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-epwin-'));
    const cfg = require('../../src/config');
    cfg.setMultisDir(tmp);
    delete require.cache[require.resolve('../../src/context')];
    context = require('../../src/context');
    await context.init({ documents: {}, episodeWindowDays: 90 });
  });

  after(() => {
    require('../../src/config').setMultisDir(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a 90-day window retains an episode the 30-day default would prune', async () => {
    const now = Date.now();
    const admin = context.raw().scoped('admin');
    // an episode older than litectx's 30d default but inside the configured 90d window
    await admin.remember('ep:aged', 'forty-five days ago', { kind: 'episode', by: 'agent', occurredAt: now - 45 * DAY });
    // a fresh write triggers litectx's write-time prune (pruneStaleEpisodes)
    await admin.remember('ep:fresh', 'just now', { kind: 'episode', by: 'agent', occurredAt: now - 1000 });

    const eps = await context.recentMemory('admin', { kind: 'episode', n: 10 });
    const names = eps.map((e) => e.name);
    assert.ok(names.includes('ep:aged'), 'the 45-day episode survives under the configured 90d window (wiring took)');
    assert.ok(names.includes('ep:fresh'), 'the fresh episode is present');
  });
});
