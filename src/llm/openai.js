const https = require('https');
const { LLMProvider } = require('./base');

/**
 * OpenAI GPT provider (vanilla Node.js https)
 */
class OpenAIProvider extends LLMProvider {
  constructor(apiKey, model = 'gpt-4o') {
    super();
    this.apiKey = apiKey;
    this.model = model;
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

  _makeRequest(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);

      const options = {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Authorization': `Bearer ${this.apiKey}`
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

module.exports = { OpenAIProvider };
