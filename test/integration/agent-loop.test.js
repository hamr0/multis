const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { createMessageRouter } = require('../../src/bot/handlers');
const { TOOLS } = require('../../src/tools/definitions');
const { buildToolRegistry, getToolsForUser } = require('../../src/tools/registry');
const { createTestEnv, mockPlatform, msg } = require('../helpers/setup');

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
