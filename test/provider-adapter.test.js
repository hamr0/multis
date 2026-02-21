const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createProvider, simpleGenerate } = require('../src/llm/provider-adapter');

// ---------------------------------------------------------------------------
// createProvider
// ---------------------------------------------------------------------------

describe('createProvider', () => {
  it('throws on missing Anthropic API key', () => {
    assert.throws(
      () => createProvider({ provider: 'anthropic' }),
      /Anthropic API key is required/
    );
  });

  it('throws on missing OpenAI API key', () => {
    assert.throws(
      () => createProvider({ provider: 'openai' }),
      /OpenAI API key is required/
    );
  });

  it('accepts Ollama without API key', () => {
    const provider = createProvider({ provider: 'ollama', model: 'llama3' });
    assert.ok(provider);
    assert.strictEqual(typeof provider.generate, 'function');
  });

  it('throws on unknown provider', () => {
    assert.throws(
      () => createProvider({ provider: 'grok', apiKey: 'k' }),
      /Unknown LLM provider: grok/
    );
  });

  it('defaults to anthropic', () => {
    assert.throws(
      () => createProvider({}),
      /Anthropic API key is required/
    );
  });

  it('creates Anthropic provider with key', () => {
    const provider = createProvider({ provider: 'anthropic', apiKey: 'test-key', model: 'claude-haiku-4-5-20251001' });
    assert.ok(provider);
    assert.strictEqual(typeof provider.generate, 'function');
  });

  it('creates OpenAI provider with key', () => {
    const provider = createProvider({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o-mini' });
    assert.ok(provider);
    assert.strictEqual(typeof provider.generate, 'function');
  });

  it('is case-insensitive', () => {
    const provider = createProvider({ provider: 'OLLAMA', model: 'llama3' });
    assert.ok(provider);
  });
});

// ---------------------------------------------------------------------------
// simpleGenerate
// ---------------------------------------------------------------------------

describe('simpleGenerate', () => {
  it('wraps provider.generate with legacy signature', async () => {
    const calls = [];
    const fakeProvider = {
      generate: async (messages, tools, options) => {
        calls.push({ messages, tools, options });
        return { text: 'hello world', toolCalls: [], usage: {} };
      }
    };

    const wrapper = simpleGenerate(fakeProvider);
    const result = await wrapper.generate('test prompt', { system: 'sys', maxTokens: 100 });

    assert.strictEqual(result, 'hello world');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].messages, [{ role: 'user', content: 'test prompt' }]);
    assert.deepStrictEqual(calls[0].tools, []);
    assert.strictEqual(calls[0].options.system, 'sys');
    assert.strictEqual(calls[0].options.maxTokens, 100);
  });

  it('defaults opts to empty', async () => {
    const fakeProvider = {
      generate: async () => ({ text: 'ok', toolCalls: [], usage: {} })
    };
    const wrapper = simpleGenerate(fakeProvider);
    const result = await wrapper.generate('hi');
    assert.strictEqual(result, 'ok');
  });
});
