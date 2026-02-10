const https = require('https');
const { LLMProvider } = require('./base');

/**
 * Anthropic Claude provider (vanilla Node.js https)
 */
class AnthropicProvider extends LLMProvider {
  constructor(apiKey, model = 'claude-sonnet-4-5-20250929') {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.apiVersion = '2023-06-01';
  }

  async generate(prompt, options = {}) {
    const body = {
      model: this.model,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature || 0.7,
      messages: [{ role: 'user', content: prompt }]
    };

    if (options.system) {
      body.system = options.system;
    }

    const response = await this._makeRequest(body);

    return response.content[0].text;
  }

  async generateWithTools(prompt, tools, options = {}) {
    const response = await this._makeRequest({
      model: this.model,
      max_tokens: options.maxTokens || 2048,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema
      })),
      messages: [{ role: 'user', content: prompt }]
    });

    return response;
  }

  _makeRequest(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion
        }
      };

      const req = https.request(options, (res) => {
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

module.exports = { AnthropicProvider };
