/**
 * Provider adapter — maps multis config.llm to bareagent providers.
 * Replaces src/llm/client.js (factory function).
 */

const { Anthropic, OpenAI, Ollama } = require('bare-agent/providers');

/**
 * Create a bareagent provider from multis LLM config.
 * @param {Object} config — { provider, apiKey, model, baseUrl }
 * @returns {Object} — bareagent provider instance
 */
function createProvider(config) {
  const provider = (config.provider || 'anthropic').toLowerCase();

  switch (provider) {
    case 'anthropic':
      if (!config.apiKey) throw new Error('Anthropic API key is required');
      return new Anthropic({ apiKey: config.apiKey, model: config.model });

    case 'openai':
      if (!config.apiKey) throw new Error('OpenAI API key is required');
      return new OpenAI({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl });

    case 'ollama':
      return new Ollama({ model: config.model, url: config.baseUrl });

    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

/**
 * Wraps a bareagent provider to expose the old generate(prompt, opts) signature.
 * Used by capture.js and any caller that just wants text output without tools.
 * @param {Object} provider — bareagent provider
 * @returns {Object} — { generate(prompt, opts) }
 */
function simpleGenerate(provider) {
  return {
    generate: async (prompt, opts = {}) => {
      const messages = [{ role: 'user', content: prompt }];
      const result = await provider.generate(messages, [], {
        system: opts.system,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
      });
      return result.text;
    }
  };
}

module.exports = { createProvider, simpleGenerate };
