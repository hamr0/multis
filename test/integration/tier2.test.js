const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createMessageRouter } = require('../../src/bot/handlers');
const { createTestEnv, mockPlatform, mockLLM, msg } = require('../helpers/setup');
const { parseRemind, parseCron, formatJob } = require('../../src/bot/scheduler');
const { handleApprovalReply, hasPendingApproval } = require('../../src/bot/checkpoint');

// Stub indexer
function stubIndexer() {
  return {
    search: () => [],
    indexFile: async () => 0,
    indexBuffer: async () => 0,
    getStats: () => ({ indexedFiles: 0, totalChunks: 0, byType: {} }),
    store: { recordSearchAccess: () => {} }
  };
}

// ---------------------------------------------------------------------------
// Scheduler parsing
// ---------------------------------------------------------------------------

describe('parseRemind', () => {
  it('parses valid remind args', () => {
    const result = parseRemind('2h check inbox');
    assert.deepStrictEqual(result, { schedule: '2h', action: 'check inbox' });
  });

  it('parses minutes', () => {
    const result = parseRemind('30m call back');
    assert.deepStrictEqual(result, { schedule: '30m', action: 'call back' });
  });

  it('returns null for empty args', () => {
    assert.strictEqual(parseRemind(''), null);
    assert.strictEqual(parseRemind(null), null);
  });

  it('returns null for missing duration', () => {
    assert.strictEqual(parseRemind('check inbox'), null);
  });
});

describe('parseCron', () => {
  it('parses valid cron expression', () => {
    const result = parseCron('0 9 * * 1-5 morning briefing');
    assert.deepStrictEqual(result, { schedule: '0 9 * * 1-5', action: 'morning briefing' });
  });

  it('returns null for empty args', () => {
    assert.strictEqual(parseCron(''), null);
    assert.strictEqual(parseCron(null), null);
  });

  it('returns null for incomplete cron', () => {
    // Only 3 fields, not 5
    assert.strictEqual(parseCron('0 9 * check'), null);
  });
});

describe('formatJob', () => {
  it('formats one-shot job', () => {
    const result = formatJob({ id: 'j1', type: 'one-shot', schedule: '2h', action: 'check' });
    assert.match(result, /j1/);
    assert.match(result, /one-shot/);
    assert.match(result, /check/);
  });

  it('formats recurring job', () => {
    const result = formatJob({ id: 'j2', type: 'recurring', schedule: '0 9 * * *', action: 'brief' });
    assert.match(result, /recurring/);
  });
});

// ---------------------------------------------------------------------------
// Scheduler commands via router
// ---------------------------------------------------------------------------

describe('/remind command', () => {
  it('rejects non-owner', async () => {
    const env = createTestEnv({ allowed_users: ['user1', 'user2'], owner_id: 'user1' });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });

    await router(msg('/remind 1h test', { senderId: 'user2' }), platform);
    assert.match(platform.lastTo('chat1').text, /Owner only/);
  });

  it('shows usage for missing args', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });

    await router(msg('/remind'), platform);
    assert.match(platform.lastTo('chat1').text, /Usage/);
  });
});

describe('/jobs command', () => {
  it('shows no active jobs', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });

    await router(msg('/jobs'), platform);
    // Should respond (either "No active jobs" or a list)
    assert.ok(platform.sent.length > 0);
  });
});

describe('/cancel command', () => {
  it('shows usage for missing id', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });

    await router(msg('/cancel'), platform);
    assert.match(platform.lastTo('chat1').text, /Usage/);
  });

  it('reports not found for bad id', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });

    await router(msg('/cancel nonexistent'), platform);
    assert.match(platform.lastTo('chat1').text, /not found/);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

describe('Checkpoint approval replies', () => {
  it('hasPendingApproval returns false when no pending', () => {
    assert.strictEqual(hasPendingApproval('nobody'), false);
  });

  it('handleApprovalReply returns false when no pending', () => {
    assert.strictEqual(handleApprovalReply('nobody', 'yes'), false);
  });
});

// ---------------------------------------------------------------------------
// /plan command
// ---------------------------------------------------------------------------

describe('/plan command', () => {
  it('rejects non-owner', async () => {
    const env = createTestEnv({ allowed_users: ['user1', 'user2'], owner_id: 'user1' });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });

    await router(msg('/plan organize docs', { senderId: 'user2' }), platform);
    assert.match(platform.lastTo('chat1').text, /Owner only/);
  });

  it('shows usage for missing goal', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });

    await router(msg('/plan'), platform);
    assert.match(platform.lastTo('chat1').text, /Usage/);
  });
});
