const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { createMessageRouter } = require('../../src/bot/handlers');
const { TOOLS } = require('../../src/tools/definitions');
const { buildToolRegistry, getToolsForUser, toLLMSchemas } = require('../../src/tools/registry');
const { createTestEnv, mockPlatform, msg } = require('../helpers/setup');

/**
 * Mock LLM that supports the tool-calling protocol.
 * Configured with a sequence of responses to return on each call.
 */
function mockToolLLM(responseSequence) {
  let callIndex = 0;
  const calls = [];

  return {
    generate: async (prompt, opts) => {
      calls.push({ type: 'generate', prompt, opts });
      return 'fallback answer';
    },
    generateWithMessages: async (msgs, opts) => {
      calls.push({ type: 'generateWithMessages', msgs, opts });
      // Used for final text-only fallback
      return 'final fallback answer';
    },
    generateWithToolsAndMessages: async (msgs, tools, opts) => {
      calls.push({ type: 'generateWithToolsAndMessages', msgs, tools, opts });
      const resp = responseSequence[callIndex] || { type: 'text', text: 'done' };
      callIndex++;
      return resp.raw;
    },
    parseToolResponse: (response) => {
      if (response._parsed) return response._parsed;
      return { text: response.text || '', toolCalls: [] };
    },
    formatToolResult: (toolCallId, result) => {
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCallId, content: result }] };
    },
    formatAssistantMessage: (response) => {
      return { role: 'assistant', content: response.content || response.text || '' };
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
    const llm = mockToolLLM([
      {
        raw: {
          _parsed: { text: 'The time is 3pm', toolCalls: [] },
          content: 'The time is 3pm'
        }
      }
    ]);

    const allTools = buildToolRegistry({}, 'linux');
    const router = createMessageRouter(env.config, {
      llm, indexer: stubIndexer(),
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

    const llm = mockToolLLM([
      // Round 1: LLM asks to search docs
      {
        raw: {
          _parsed: {
            text: '',
            toolCalls: [{ id: 'tc1', name: 'search_docs', input: { query: 'meeting notes' } }]
          },
          content: [{ type: 'tool_use', id: 'tc1', name: 'search_docs', input: { query: 'meeting notes' } }]
        }
      },
      // Round 2: LLM replies with text after getting tool result
      {
        raw: {
          _parsed: { text: 'Based on the docs: the meeting is at 3pm.', toolCalls: [] },
          content: 'Based on the docs: the meeting is at 3pm.'
        }
      }
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
      llm, indexer: stubIndexer(),
      tools: [searchDocsTool],
      toolsConfig: {},
      runtimePlatform: 'linux'
    });

    await router(msg('/ask when is the meeting'), platform);

    // LLM was called twice (tool call + final response)
    assert.strictEqual(llm.calls.filter(c => c.type === 'generateWithToolsAndMessages').length, 2);
    // Final answer sent to user
    assert.match(platform.lastTo('chat1').text, /3pm/);
  });

  it('non-owner cannot use owner_only tools', async () => {
    const env = createTestEnv({ allowed_users: ['user1', 'user2'], owner_id: 'user1' });
    const platform = mockPlatform();

    const llm = mockToolLLM([
      {
        raw: {
          _parsed: { text: 'I cannot access that tool.', toolCalls: [] },
          content: 'I cannot access that tool.'
        }
      }
    ]);

    const allTools = buildToolRegistry({}, 'linux');
    const router = createMessageRouter(env.config, {
      llm, indexer: stubIndexer(),
      tools: allTools,
      toolsConfig: {},
      runtimePlatform: 'linux'
    });

    await router(msg('/ask list my files', { senderId: 'user2' }), platform);

    // Non-owner LLM call should NOT include exec tool in schemas
    const toolCall = llm.calls.find(c => c.type === 'generateWithToolsAndMessages');
    if (toolCall) {
      const toolNames = toolCall.tools.map(t => t.name);
      assert.ok(!toolNames.includes('exec'), 'non-owner should not see exec tool');
      assert.ok(!toolNames.includes('clipboard'), 'non-owner should not see clipboard tool');
    }
  });

  it('disabled tools are not sent to LLM', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();

    const llm = mockToolLLM([
      {
        raw: {
          _parsed: { text: 'ok', toolCalls: [] },
          content: 'ok'
        }
      }
    ]);

    // Disable open_url
    const toolsConfig = { tools: { open_url: { enabled: false } } };
    const allTools = buildToolRegistry(toolsConfig, 'linux');
    const router = createMessageRouter(env.config, {
      llm, indexer: stubIndexer(),
      tools: allTools,
      toolsConfig,
      runtimePlatform: 'linux'
    });

    await router(msg('/ask open youtube'), platform);

    const toolCall = llm.calls.find(c => c.type === 'generateWithToolsAndMessages');
    if (toolCall) {
      const toolNames = toolCall.tools.map(t => t.name);
      assert.ok(!toolNames.includes('open_url'), 'disabled tool should not be in LLM schemas');
    }
  });

  it('max rounds limits agent loop iterations', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    env.config.llm = { ...env.config.llm, max_tool_rounds: 2 };
    const platform = mockPlatform();

    // LLM keeps calling tools forever
    const infiniteToolCalls = Array.from({ length: 10 }, (_, i) => ({
      raw: {
        _parsed: {
          text: '',
          toolCalls: [{ id: `tc${i}`, name: 'search_docs', input: { query: `query ${i}` } }]
        },
        content: [{ type: 'tool_use' }]
      }
    }));

    const llm = mockToolLLM(infiniteToolCalls);

    const searchTool = {
      name: 'search_docs',
      description: 'Search docs',
      platforms: ['linux'],
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async () => 'result'
    };

    const router = createMessageRouter(env.config, {
      llm, indexer: stubIndexer(),
      tools: [searchTool],
      toolsConfig: {},
      runtimePlatform: 'linux'
    });

    await router(msg('/ask loop forever'), platform);

    // Should have been limited: 2 tool rounds + 1 final generateWithMessages
    const toolCalls = llm.calls.filter(c => c.type === 'generateWithToolsAndMessages');
    assert.ok(toolCalls.length <= 2, `Expected max 2 tool rounds, got ${toolCalls.length}`);
    // Should still produce an answer
    assert.ok(platform.sent.length > 0);
  });

  it('works without tools (backward compatible — no tool deps)', async () => {
    const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
    const platform = mockPlatform();

    // Simple mock LLM without tool support
    const llm = {
      generate: async () => 'simple answer',
      generateWithMessages: async () => 'simple answer',
      calls: []
    };

    const router = createMessageRouter(env.config, {
      llm, indexer: stubIndexer(),
      tools: [], // no tools
      toolsConfig: {},
      runtimePlatform: 'linux'
    });

    await router(msg('/ask hello'), platform);
    assert.match(platform.lastTo('chat1').text, /simple answer/);
  });
});
