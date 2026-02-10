const http = require('http');
const { LLMProvider } = require('./base');

/**
 * Ollama local LLM provider (vanilla Node.js http)
 */
class OllamaProvider extends LLMProvider {
  constructor(model = 'llama3.1:8b', baseUrl = 'http://localhost:11434') {
    super();
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async generate(prompt, options = {}) {
    const body = {
      model: this.model,
      prompt,
      stream: false,
      options: {
        temperature: options.temperature || 0.7,
        num_predict: options.maxTokens || 2048
      }
    };

    if (options.system) {
      body.system = options.system;
    }

    const response = await this._makeRequest(body);

    return response.response;
  }

  async generateWithTools(prompt, tools, options = {}) {
    // Ollama doesn't natively support tool calling yet
    // We can implement a simple version by prompting the model
    const toolsDescription = tools.map(t =>
      `Tool: ${t.name}\nDescription: ${t.description}\nParameters: ${JSON.stringify(t.inputSchema)}`
    ).join('\n\n');

    const systemPrompt = `You have access to these tools:\n\n${toolsDescription}\n\nTo use a tool, respond with JSON in this format: {"tool": "tool_name", "parameters": {...}}`;

    const response = await this.generate(prompt, {
      ...options,
      system: systemPrompt
    });

    return { content: response };
  }

  _makeRequest(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const url = new URL('/api/generate', this.baseUrl);

      const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = http.request(options, (res) => {
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
            reject(new Error(`Ollama error (${res.statusCode}): ${responseBody}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}

module.exports = { OllamaProvider };
