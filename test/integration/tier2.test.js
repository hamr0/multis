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
    assert.deepStrictEqual(result, { schedule: '2h', action: 'check inbox', agentic: false });
  });

  it('parses minutes', () => {
    const result = parseRemind('30m call back');
    assert.deepStrictEqual(result, { schedule: '30m', action: 'call back', agentic: false });
  });

  it('returns null for empty args', () => {
    assert.strictEqual(parseRemind(''), null);
    assert.strictEqual(parseRemind(null), null);
  });

  it('returns null for missing duration', () => {
    assert.strictEqual(parseRemind('check inbox'), null);
  });

  it('returns null for invalid duration format', () => {
    assert.strictEqual(parseRemind('2x do something'), null);
    assert.strictEqual(parseRemind('abc do something'), null);
  });

  it('parses seconds and days', () => {
    assert.deepStrictEqual(parseRemind('30s ping'), { schedule: '30s', action: 'ping', agentic: false });
    assert.deepStrictEqual(parseRemind('1d review'), { schedule: '1d', action: 'review', agentic: false });
  });

  it('strips --agent flag and sets agentic true', () => {
    const result = parseRemind('2h check inbox --agent');
    assert.deepStrictEqual(result, { schedule: '2h', action: 'check inbox', agentic: true });
  });

  it('strips --agent from middle of action', () => {
    const result = parseRemind('1h --agent summarize docs');
    assert.deepStrictEqual(result, { schedule: '1h', action: 'summarize docs', agentic: true });
  });
});

describe('parseCron', () => {
  it('parses valid cron expression', () => {
    const result = parseCron('0 9 * * 1-5 morning briefing');
    assert.deepStrictEqual(result, { schedule: '0 9 * * 1-5', action: 'morning briefing', agentic: false });
  });

  it('returns null for empty args', () => {
    assert.strictEqual(parseCron(''), null);
    assert.strictEqual(parseCron(null), null);
  });

  it('returns null for incomplete cron', () => {
    // Only 3 fields, not 5
    assert.strictEqual(parseCron('0 9 * check'), null);
  });

  it('returns null for 5 fields but no action', () => {
    assert.strictEqual(parseCron('0 9 * * 1-5'), null);
  });

  it('strips --agent flag and sets agentic true', () => {
    const result = parseCron('0 9 * * 1-5 morning briefing --agent');
    assert.deepStrictEqual(result, { schedule: '0 9 * * 1-5', action: 'morning briefing', agentic: true });
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

  it('shows [agent] tag for agentic jobs', () => {
    const result = formatJob({ id: 'j3', type: 'one-shot', schedule: '1h', action: 'check', agentic: true });
    assert.match(result, /\[agent\]/);
  });

  it('no [agent] tag for plain jobs', () => {
    const result = formatJob({ id: 'j4', type: 'one-shot', schedule: '1h', action: 'check', agentic: false });
    assert.doesNotMatch(result, /\[agent\]/);
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

  it('handleApprovalReply ignores non-yes/no text when no pending', () => {
    assert.strictEqual(handleApprovalReply('nobody', 'maybe'), false);
  });

  it('hasPendingApproval returns false for different senderIds', () => {
    assert.strictEqual(hasPendingApproval('user-a'), false);
    assert.strictEqual(hasPendingApproval('user-b'), false);
    assert.strictEqual(hasPendingApproval(''), false);
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

// ---------------------------------------------------------------------------
// createSchedulerTick — centralized tick handler
// ---------------------------------------------------------------------------

const { createSchedulerTick } = require('../../src/bot/handlers');

describe('createSchedulerTick', () => {
  it('sends plain text for non-agentic job', async () => {
    const platform = mockPlatform();
    const registry = new Map([['telegram', platform]]);

    const tick = createSchedulerTick({
      platformRegistry: registry,
      config: { owner_id: 'user1', llm: {} },
      provider: null,
      indexer: null,
      getMem: null,
      memCfg: {},
      allTools: [],
      toolsConfig: {},
      runtimePlatform: 'linux',
      maxToolRounds: 5
    });

    await tick({ id: 'j1', action: 'check inbox', agentic: false, chatId: 'chat1', platformName: 'telegram' });
    assert.strictEqual(platform.sent.length, 1);
    assert.match(platform.sent[0].text, /Reminder: check inbox/);
    assert.strictEqual(platform.sent[0].chatId, 'chat1');
  });

  it('sends error when agentic but no LLM provider', async () => {
    const platform = mockPlatform();
    const registry = new Map([['telegram', platform]]);

    const tick = createSchedulerTick({
      platformRegistry: registry,
      config: { owner_id: 'user1', llm: {} },
      provider: null,
      indexer: null,
      getMem: null,
      memCfg: {},
      allTools: [],
      toolsConfig: {},
      runtimePlatform: 'linux',
      maxToolRounds: 5
    });

    await tick({ id: 'j2', action: 'summarize docs', agentic: true, chatId: 'chat1', platformName: 'telegram' });
    assert.strictEqual(platform.sent.length, 1);
    assert.match(platform.sent[0].text, /LLM not configured/);
  });

  it('runs agent loop for agentic job', async () => {
    const platform = mockPlatform();
    const registry = new Map([['telegram', platform]]);
    const llm = mockLLM('Agent response here');

    const tick = createSchedulerTick({
      platformRegistry: registry,
      config: { owner_id: 'user1', llm: { provider: 'mock' } },
      provider: llm,
      indexer: stubIndexer(),
      getMem: () => ({ loadMemory: () => '', loadRecent: () => [] }),
      memCfg: {},
      allTools: [],
      toolsConfig: {},
      runtimePlatform: 'linux',
      maxToolRounds: 5
    });

    await tick({ id: 'j3', action: 'what time is it', agentic: true, chatId: 'chat1', platformName: 'telegram' });
    assert.strictEqual(platform.sent.length, 1);
    assert.match(platform.sent[0].text, /Agent response/);
  });

  it('falls back to first platform when platformName not found', async () => {
    const platform = mockPlatform();
    const registry = new Map([['beeper', platform]]);

    const tick = createSchedulerTick({
      platformRegistry: registry,
      config: { owner_id: 'user1', llm: {} },
      provider: null,
      indexer: null,
      getMem: null,
      memCfg: {},
      allTools: [],
      toolsConfig: {},
      runtimePlatform: 'linux',
      maxToolRounds: 5
    });

    await tick({ id: 'j4', action: 'hello', agentic: false, chatId: 'chat1', platformName: 'telegram' });
    assert.strictEqual(platform.sent.length, 1);
    assert.match(platform.sent[0].text, /Reminder: hello/);
  });

  it('catches agent loop errors and sends to chat', async () => {
    const platform = mockPlatform();
    const registry = new Map([['telegram', platform]]);
    // Provider that throws
    const badProvider = {
      generate: async () => { throw new Error('LLM down'); }
    };

    const tick = createSchedulerTick({
      platformRegistry: registry,
      config: { owner_id: 'user1', llm: { provider: 'mock' } },
      provider: badProvider,
      indexer: stubIndexer(),
      getMem: () => ({ loadMemory: () => '', loadRecent: () => [] }),
      memCfg: {},
      allTools: [],
      toolsConfig: {},
      runtimePlatform: 'linux',
      maxToolRounds: 5
    });

    await tick({ id: 'j5', action: 'fail task', agentic: true, chatId: 'chat1', platformName: 'telegram' });
    assert.strictEqual(platform.sent.length, 1);
    assert.match(platform.sent[0].text, /Job \[j5\] failed/);
  });

  it('uses chatId and platformName from job, not closure', async () => {
    const tgPlatform = mockPlatform();
    const bpPlatform = mockPlatform();
    const registry = new Map([['telegram', tgPlatform], ['beeper', bpPlatform]]);

    const tick = createSchedulerTick({
      platformRegistry: registry,
      config: { owner_id: 'user1', llm: {} },
      provider: null,
      indexer: null,
      getMem: null,
      memCfg: {},
      allTools: [],
      toolsConfig: {},
      runtimePlatform: 'linux',
      maxToolRounds: 5
    });

    // Job targeting beeper chat
    await tick({ id: 'j6', action: 'beeper reminder', agentic: false, chatId: 'bp-chat-99', platformName: 'beeper' });
    assert.strictEqual(bpPlatform.sent.length, 1);
    assert.strictEqual(bpPlatform.sent[0].chatId, 'bp-chat-99');
    assert.strictEqual(tgPlatform.sent.length, 0);

    // Job targeting telegram chat
    await tick({ id: 'j7', action: 'tg reminder', agentic: false, chatId: 'tg-chat-42', platformName: 'telegram' });
    assert.strictEqual(tgPlatform.sent.length, 1);
    assert.strictEqual(tgPlatform.sent[0].chatId, 'tg-chat-42');
  });
});
