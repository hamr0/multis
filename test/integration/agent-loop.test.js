const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { createMessageRouter } = require('../../src/bot/handlers');
const { TOOLS } = require('../../src/tools/definitions');
const { buildToolRegistry, getToolsForUser } = require('../../src/tools/registry');
const { createTestEnv, mockPlatform, msg } = require('../helpers/setup');
const { PinManager, hashPin } = require('../../src/security/pin');
const { PendingRegistry } = require('../../src/bot/pending');

/**
 * Mock bareagent-compatible provider.
 * provider.generate(messages, tools, options) → { text, toolCalls, usage }
 * Configured with a sequence of responses to return on each call.
 */
function mockToolProvider(responseSequence) {
  let callIndex = 0;
  const calls = [];

  return {
    generate: async (messages, tools, options) => {
      calls.push({ type: 'generate', messages, tools, options });
      const resp = responseSequence[callIndex] || { text: 'done', toolCalls: [] };
      callIndex++;
      return { text: resp.text || '', toolCalls: resp.toolCalls || [], usage: { inputTokens: 0, outputTokens: 0 } };
    },
    calls
  };
}

// Stub indexer
function stubIndexer(chunks = []) {
  const searchCalls = [];
  return {
    search: (query, limit, opts = {}) => { searchCalls.push({ query, limit, opts }); return chunks; },
    searchCalls,
    indexFile: async () => 0,
    indexBuffer: async () => 0,
    getStats: () => ({ indexedFiles: 0, totalChunks: 0, byType: {} }),
    store: { recordSearchAccess: () => {} }
  };
}

// ---------------------------------------------------------------------------
// Agent loop tests
// ---------------------------------------------------------------------------

describe('Agent loop with tool calling', () => {
  it('LLM returns text-only — no tool calls, normal response', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();
    const provider = mockToolProvider([
      { text: 'The time is 3pm', toolCalls: [] }
    ]);

    const allTools = buildToolRegistry({}, 'linux');
    const router = createMessageRouter(env.config, {
      provider, indexer: stubIndexer(),
      tools: allTools,
      toolsConfig: {},
      runtimePlatform: 'linux'
    });

    await router(msg('/ask what time is it'), platform);
    assert.match(platform.lastTo('chat1').text, /3pm/);
  });

  it('LLM calls a tool, gets result, then responds with text', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();

    const provider = mockToolProvider([
      // Round 1: LLM asks to search docs
      {
        text: '',
        toolCalls: [{ id: 'tc1', name: 'search_docs', arguments: { query: 'meeting notes' } }]
      },
      // Round 2: LLM replies with text after getting tool result
      { text: 'Based on the docs: the meeting is at 3pm.', toolCalls: [] }
    ]);

    // Provide a search_docs tool that returns a result
    const searchDocsTool = {
      name: 'search_docs',
      description: 'Search docs',
      platforms: ['linux'],
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async () => 'Meeting scheduled for 3pm on Monday.'
    };

    const router = createMessageRouter(env.config, {
      provider, indexer: stubIndexer(),
      tools: [searchDocsTool],
      toolsConfig: {},
      runtimePlatform: 'linux'
    });

    await router(msg('/ask when is the meeting'), platform);

    // LLM was called twice (tool call + final response)
    assert.strictEqual(provider.calls.length, 2);
    // Final answer sent to user
    assert.match(platform.lastTo('chat1').text, /3pm/);
  });

  it('non-owner cannot use owner_only tools', async () => {
    const env = createTestEnv({ allowed_users: ['user1', 'user2'], owner_id: 'user1' });
    const platform = mockPlatform();

    const provider = mockToolProvider([
      { text: 'I cannot access that tool.', toolCalls: [] }
    ]);

    const allTools = buildToolRegistry({}, 'linux');
    const router = createMessageRouter(env.config, {
      provider, indexer: stubIndexer(),
      tools: allTools,
      toolsConfig: {},
      runtimePlatform: 'linux'
    });

    await router(msg('/ask list my files', { senderId: 'user2' }), platform);

    // Non-owner LLM call should NOT include exec tool
    const call = provider.calls[0];
    if (call) {
      const toolNames = call.tools.map(t => t.name);
      assert.ok(!toolNames.includes('exec'), 'non-owner should not see exec tool');
      assert.ok(!toolNames.includes('clipboard'), 'non-owner should not see clipboard tool');
    }
  });

  it('disabled tools are not sent to LLM', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();

    const provider = mockToolProvider([
      { text: 'ok', toolCalls: [] }
    ]);

    // Disable open_url
    const toolsConfig = { tools: { open_url: { enabled: false } } };
    const allTools = buildToolRegistry(toolsConfig, 'linux');
    const router = createMessageRouter(env.config, {
      provider, indexer: stubIndexer(),
      tools: allTools,
      toolsConfig,
      runtimePlatform: 'linux'
    });

    await router(msg('/ask open youtube'), platform);

    const call = provider.calls[0];
    if (call) {
      const toolNames = call.tools.map(t => t.name);
      assert.ok(!toolNames.includes('open_url'), 'disabled tool should not be in LLM schemas');
    }
  });

  it('max rounds limits agent loop iterations', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    env.config.llm = { ...env.config.llm, max_tool_rounds: 2 };
    const platform = mockPlatform();

    // LLM keeps calling tools forever
    const infiniteToolCalls = Array.from({ length: 10 }, (_, i) => ({
      text: '',
      toolCalls: [{ id: `tc${i}`, name: 'search_docs', arguments: { query: `query ${i}` } }]
    }));

    const provider = mockToolProvider(infiniteToolCalls);

    const searchTool = {
      name: 'search_docs',
      description: 'Search docs',
      platforms: ['linux'],
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async () => 'result'
    };

    const router = createMessageRouter(env.config, {
      provider, indexer: stubIndexer(),
      tools: [searchTool],
      toolsConfig: {},
      runtimePlatform: 'linux'
    });

    await router(msg('/ask loop forever'), platform);

    // Should have been limited to max rounds
    assert.ok(provider.calls.length <= 3, `Expected max ~3 calls, got ${provider.calls.length}`);
    // Should still produce an answer
    assert.ok(platform.sent.length > 0);
  });

  // M9 increment 3 — the LLM door through the one governed core. An exec tool call
  // the model makes runs its execute through runGovernedAction: benign runs free,
  // destructive PINs in-window, catastrophic is hard-walled (never runs). The
  // ceremony is the SAME core the slash door uses; gate.js `policy` no longer holds
  // a 3-tier. Ceremony is inline-await on the gate_reply waiter, so a destructive
  // call doesn't resolve until the PIN does → fire-without-await + poll.
  describe('governed-core ceremony on the agent path', () => {
    const flush = () => new Promise((r) => setImmediate(r));
    async function waitFor(pred, label = 'condition', tries = 500) {
      for (let i = 0; i < tries; i++) { if (pred()) return; await flush(); }
      throw new Error(`waitFor timed out: ${label}`);
    }
    // A stub `exec` (owner-only by name) that records what it ran instead of
    // touching the machine — so "did it run?" is observable without real mutation.
    function execStub(ran) {
      return {
        name: 'exec', description: 'Run a shell command', platforms: ['linux'], owner_only: true,
        input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        execute: async (args) => { ran.push(args.command); return `ran: ${args.command}`; },
      };
    }
    function build(toolCalls, ran) {
      const env = createTestEnv({
        allowed_users: ['user1'], owner_id: 'user1',
        security: { pin_hash: hashPin('1234'), pin_timeout_hours: 24, checkpoint_tools: [] },
      });
      const platform = mockPlatform();
      const pinManager = new PinManager(env.config); pinManager.sessions = {};
      const pending = new PendingRegistry();
      const provider = mockToolProvider([{ text: '', toolCalls }, { text: 'done.', toolCalls: [] }]);
      const router = createMessageRouter(env.config, {
        provider, indexer: stubIndexer(), tools: [execStub(ran)], toolsConfig: {}, runtimePlatform: 'linux',
        pinManager, pending, fileless: true,
        governanceFile: { commands: { allowlist: ['ls', 'echo'], denylist: ['rm'] }, paths: { allowed: ['/'], denied: [] } },
      });
      router.registerPlatform('telegram', platform);
      return { platform, router, ran };
    }

    it('a benign exec the model calls runs free (no PIN)', async () => {
      const ran = [];
      const { platform, router } = build([{ id: 't1', name: 'exec', arguments: { command: 'ls ~/Music' } }], ran);
      await router(msg('/ask list my music'), platform);
      assert.ok(!platform.sent.some((s) => /PIN/i.test(s.text)), 'no ceremony for a benign command');
      assert.deepStrictEqual(ran, ['ls ~/Music'], 'benign command ran straight through');
    });

    it('a destructive exec the model calls PINs in-window, then runs on the correct PIN', async () => {
      const ran = [];
      const { platform, router } = build([{ id: 't1', name: 'exec', arguments: { command: 'rm notes.txt' } }], ran);
      const p = router(msg('/ask delete my notes'), platform);
      await waitFor(() => platform.sent.some((s) => /PIN/i.test(s.text)), 'PIN prompt');
      assert.deepStrictEqual(ran, [], 'not run before the PIN clears');
      assert.match(platform.sent.find((s) => /PIN/i.test(s.text)).text, /rm notes\.txt/, 'verbatim echo');
      await router(msg('1234'), platform);
      await p;
      assert.deepStrictEqual(ran, ['rm notes.txt'], 'ran after the correct PIN');
    });

    it('a catastrophic exec the model calls is HARD-WALLED — no PIN, never runs', async () => {
      const ran = [];
      const { platform, router } = build([{ id: 't1', name: 'exec', arguments: { command: 'rm -rf ~/*' } }], ran);
      await router(msg('/ask wipe my home directory'), platform);
      assert.ok(!platform.sent.some((s) => /PIN/i.test(s.text)), 'a wall is not a ceremony — no PIN');
      assert.deepStrictEqual(ran, [], 'the catastrophic command never ran');
    });
  });

  it('works without tools (backward compatible — no tool deps)', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();

    // bareagent-compatible mock provider
    const provider = mockToolProvider([
      { text: 'simple answer', toolCalls: [] }
    ]);

    const router = createMessageRouter(env.config, {
      provider, indexer: stubIndexer(),
      tools: [], // no tools
      toolsConfig: {},
      runtimePlatform: 'linux'
    });

    await router(msg('/ask hello'), platform);
    assert.match(platform.lastTo('chat1').text, /simple answer/);
  });
});
