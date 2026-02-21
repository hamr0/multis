const fs = require('fs');
const path = require('path');
const os = require('os');
const { Message } = require('../../src/platforms/message');
const { setMultisDir } = require('../../src/config');

/**
 * Create an isolated test environment with temp HOME dir.
 * Redirects saveConfig/loadConfig to the temp directory so tests
 * never touch the real ~/.multis/config.json.
 */
function createTestEnv(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-int-'));
  const multisDir = path.join(tmpDir, '.multis');
  fs.mkdirSync(multisDir, { recursive: true });

  // Create organized subdirs
  for (const sub of ['data', 'auth', 'logs', 'run']) {
    fs.mkdirSync(path.join(multisDir, sub), { recursive: true });
  }

  // Redirect config module to use temp dir
  setMultisDir(multisDir);

  const config = {
    pairing_code: 'TEST42',
    allowed_users: [],
    owner_id: null,
    llm: { provider: 'mock', apiKey: 'test' },
    governance: { enabled: false },
    security: {},
    memory: { recent_window: 20, capture_threshold: 100 },
    ...overrides
  };

  fs.writeFileSync(path.join(multisDir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(multisDir, 'auth', 'governance.json'), JSON.stringify({
    commands: { allowlist: ['.*'], denylist: [], requireConfirmation: [] },
    paths: { allowed: ['.*'], denied: [] }
  }));

  // Memory base dir for test isolation (prevents leaking into real ~/.multis/memory/)
  const memoryBaseDir = path.join(multisDir, 'data', 'memory', 'chats');

  return {
    tmpDir,
    config,
    memoryBaseDir,
    cleanup: () => {
      setMultisDir(null); // restore default
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

/**
 * Mock platform — records all sent messages.
 */
function mockPlatform() {
  const sent = [];
  return {
    send: async (chatId, text) => sent.push({ chatId, text }),
    sent,
    lastTo: (chatId) => sent.filter(m => m.chatId === chatId).pop()
  };
}

/**
 * Mock LLM provider — bareagent-compatible.
 * provider.generate(messages, tools, options) → { text, toolCalls, usage }
 * Also supports legacy generate(prompt, opts) for backward compat.
 */
function mockLLM(response = 'Mock answer') {
  const calls = [];
  return {
    generate: async (messagesOrPrompt, toolsOrOpts, options) => {
      // bareagent format: generate(messages, tools, options) → { text, toolCalls, usage }
      if (Array.isArray(messagesOrPrompt) && messagesOrPrompt[0]?.role) {
        calls.push({ type: 'generate', messages: messagesOrPrompt, tools: toolsOrOpts, options });
        return { text: response, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      }
      // Legacy format: generate(prompt, opts) → string
      calls.push({ type: 'generate', prompt: messagesOrPrompt, opts: toolsOrOpts });
      return response;
    },
    calls
  };
}

/**
 * Create a Message for testing.
 */
function msg(text, overrides = {}) {
  return new Message({
    id: 'test-' + Date.now(),
    platform: 'telegram',
    chatId: 'chat1',
    senderId: 'user1',
    senderName: 'TestUser',
    text,
    ...overrides
  });
}

module.exports = { createTestEnv, mockPlatform, mockLLM, msg };
