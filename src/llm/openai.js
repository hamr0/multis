const https = require('https');
const http = require('http');
const { LLMProvider } = require('./base');

/**
 * OpenAI GPT provider (vanilla Node.js https)
 * Also works with any OpenAI-compatible API (OpenRouter, Together, Groq, etc.)
 */
class OpenAIProvider extends LLMProvider {
  constructor(apiKey, model = 'gpt-4o', baseUrl = 'https://api.openai.com') {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = (baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  }

  async generate(prompt, options = {}) {
    const messages = options.system
      ? [
          { role: 'system', content: options.system },
          { role: 'user', content: prompt }
        ]
      : [{ role: 'user', content: prompt }];

    const response = await this._makeRequest({
      model: this.model,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature || 0.7,
      messages
    });

    return response.choices[0].message.content;
  }

  async generateWithTools(prompt, tools, options = {}) {
    const response = await this._makeRequest({
      model: this.model,
      max_tokens: options.maxTokens || 2048,
      tools: tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema
        }
      })),
      messages: [{ role: 'user', content: prompt }]
    });

    return response;
  }

  async generateWithToolsAndMessages(messages, tools, options = {}) {
    const msgs = options.system
      ? [{ role: 'system', content: options.system }, ...messages]
      : [...messages];

    return await this._makeRequest({
      model: this.model,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature || 0.7,
      tools: tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema
        }
      })),
      messages: msgs
    });
  }

  parseToolResponse(response) {
    const msg = response.choices?.[0]?.message;
    if (!msg) return { text: '', toolCalls: [] };

    const text = msg.content || '';
    const toolCalls = (msg.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}')
    }));

    return { text, toolCalls };
  }

  formatToolResult(toolCallId, result) {
    return { role: 'tool', tool_call_id: toolCallId, content: result };
  }

  formatAssistantMessage(response) {
    const msg = response.choices?.[0]?.message;
    return msg || { role: 'assistant', content: '' };
  }

  async generateWithMessages(messages, options = {}) {
    const msgs = options.system
      ? [{ role: 'system', content: options.system }, ...messages]
      : [...messages];

    const response = await this._makeRequest({
      model: this.model,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature || 0.7,
      messages: msgs
    });

    return response.choices[0].message.content;
  }

  _makeRequest(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const url = new URL('/v1/chat/completions', this.baseUrl);
      const transport = url.protocol === 'http:' ? http : https;

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Authorization': `Bearer ${this.apiKey}`
        }
      };

      const req = transport.request(options, (res) => {
        let responseBody = '';

        res.on('data', (chunk) => {
          responseBody += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(responseBody));
            } catch (err) {
              reject(new Error('Failed to parse response: ' + err.message));
            }
          } else {
            reject(new Error(`API error (${res.statusCode}): ${responseBody}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}

module.exports = { OpenAIProvider };
