const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getPlatform } = require('../src/tools/platform');
const { TOOLS } = require('../src/tools/definitions');
const { buildToolRegistry, getToolsForUser, DEFAULT_OWNER_ONLY } = require('../src/tools/registry');
const { adaptTools } = require('../src/tools/adapter');
const { setMultisDir } = require('../src/config');

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

describe('getPlatform', () => {
  it('returns linux, macos, or android (never crashes)', () => {
    const result = getPlatform();
    assert.ok(['linux', 'macos', 'android', 'unknown'].includes(result));
  });

  it('detects android when PREFIX contains com.termux', () => {
    const orig = process.env.PREFIX;
    process.env.PREFIX = '/data/data/com.termux/files/usr';
    // Only works on linux platform
    if (process.platform === 'linux') {
      assert.strictEqual(getPlatform(), 'android');
    }
    if (orig === undefined) delete process.env.PREFIX;
    else process.env.PREFIX = orig;
  });
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

describe('Tool definitions', () => {
  it('all tools have required fields', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.name, `tool missing name`);
      assert.ok(tool.description, `${tool.name} missing description`);
      assert.ok(Array.isArray(tool.platforms), `${tool.name} missing platforms`);
      assert.ok(tool.platforms.length > 0, `${tool.name} has empty platforms`);
      assert.ok(tool.input_schema, `${tool.name} missing input_schema`);
      assert.strictEqual(typeof tool.execute, 'function', `${tool.name} missing execute`);
    }
  });

  it('tool names are unique', () => {
    const names = TOOLS.map(t => t.name);
    const unique = new Set(names);
    assert.strictEqual(names.length, unique.size, `Duplicate tool names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });

  it('all platforms are valid', () => {
    const valid = new Set(['linux', 'macos', 'android']);
    for (const tool of TOOLS) {
      for (const p of tool.platforms) {
        assert.ok(valid.has(p), `${tool.name} has invalid platform: ${p}`);
      }
    }
  });

  it('android-only tools exist', () => {
    const androidOnly = TOOLS.filter(t => t.platforms.length === 1 && t.platforms[0] === 'android');
    assert.ok(androidOnly.length > 0, 'Should have android-only tools');
    const names = androidOnly.map(t => t.name);
    assert.ok(names.includes('phone_call'));
    assert.ok(names.includes('sms_send'));
    assert.ok(names.includes('contacts'));
  });

  it('universal tools support all platforms', () => {
    const universal = TOOLS.filter(t => t.name === 'exec' || t.name === 'search_docs' || t.name === 'remember');
    for (const t of universal) {
      assert.ok(t.platforms.includes('linux'), `${t.name} missing linux`);
      assert.ok(t.platforms.includes('macos'), `${t.name} missing macos`);
      assert.ok(t.platforms.includes('android'), `${t.name} missing android`);
    }
  });
});

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

describe('buildToolRegistry', () => {
  it('filters by platform', () => {
    const linuxTools = buildToolRegistry({}, 'linux');
    const androidTools = buildToolRegistry({}, 'android');

    // Linux should not have phone_call
    assert.ok(!linuxTools.find(t => t.name === 'phone_call'), 'phone_call should not be on linux');
    // Android should have phone_call
    assert.ok(androidTools.find(t => t.name === 'phone_call'), 'phone_call should be on android');
    // Both should have exec
    assert.ok(linuxTools.find(t => t.name === 'exec'));
    assert.ok(androidTools.find(t => t.name === 'exec'));
  });

  it('filters by enabled config', () => {
    const config = { tools: { exec: { enabled: false } } };
    const tools = buildToolRegistry(config, 'linux');
    assert.ok(!tools.find(t => t.name === 'exec'), 'disabled exec should be filtered out');
  });

  it('returns all platform tools when no config', () => {
    const tools = buildToolRegistry({}, 'linux');
    assert.ok(tools.length > 0);
    // Should include common tools
    assert.ok(tools.find(t => t.name === 'exec'));
    assert.ok(tools.find(t => t.name === 'open_url'));
    assert.ok(tools.find(t => t.name === 'media_control'));
  });

  it('unknown platform returns only universal tools', () => {
    const tools = buildToolRegistry({}, 'unknown');
    assert.strictEqual(tools.length, 0, 'unknown platform should have no tools');
  });
});

describe('getToolsForUser', () => {
  it('owner gets all tools', () => {
    const allTools = buildToolRegistry({}, 'linux');
    const ownerTools = getToolsForUser(allTools, true, {});
    assert.strictEqual(ownerTools.length, allTools.length);
  });

  it('non-owner is filtered from owner_only tools', () => {
    const allTools = buildToolRegistry({}, 'linux');
    const userTools = getToolsForUser(allTools, false, {});
    // exec is owner_only by default
    assert.ok(!userTools.find(t => t.name === 'exec'), 'non-owner should not see exec');
    // open_url is not owner_only
    assert.ok(userTools.find(t => t.name === 'open_url'), 'non-owner should see open_url');
  });

  it('respects config override for owner_only', () => {
    const allTools = buildToolRegistry({}, 'linux');
    const config = { tools: { exec: { enabled: true, owner_only: false } } };
    const userTools = getToolsForUser(allTools, false, config);
    assert.ok(userTools.find(t => t.name === 'exec'), 'exec with owner_only:false should be visible');
  });
});

// ---------------------------------------------------------------------------
// Tool adapter (bareagent format)
// ---------------------------------------------------------------------------

describe('adaptTools', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-tool-'));
    const multisDir = path.join(tmpDir, '.multis');
    fs.mkdirSync(multisDir, { recursive: true });
    for (const sub of ['data', 'auth', 'logs', 'run']) {
      fs.mkdirSync(path.join(multisDir, sub), { recursive: true });
    }
    setMultisDir(multisDir);
    fs.writeFileSync(path.join(multisDir, 'auth', 'governance.json'), JSON.stringify({
      commands: { allowlist: ['.*'], denylist: [], requireConfirmation: [] },
      paths: { allowed: ['.*'], denied: [] }
    }));
  });

  it('converts multis tool format to bareagent format', () => {
    const tools = [TOOLS[0]]; // exec
    const ctx = { senderId: 'u', chatId: 'c', isOwner: true, runtimePlatform: 'linux' };
    const adapted = adaptTools(tools, ctx);
    assert.strictEqual(adapted.length, 1);
    assert.strictEqual(adapted[0].name, 'exec');
    assert.ok(adapted[0].description);
    assert.ok(adapted[0].parameters);
    assert.strictEqual(adapted[0].parameters.type, 'object');
    assert.strictEqual(typeof adapted[0].execute, 'function');
  });

  it('adapted tool executes with ctx closure', async () => {
    const searchTool = TOOLS.find(t => t.name === 'search_docs');
    const ctx = {
      senderId: 'user1',
      chatId: 'chat1',
      isOwner: true,
      runtimePlatform: 'linux',
      indexer: {
        search: () => [{ sectionPath: ['FAQ'], name: 'doc.pdf', content: 'The answer is 42' }]
      }
    };
    const adapted = adaptTools([searchTool], ctx);
    const result = await adapted[0].execute({ query: 'answer' });
    assert.match(result, /42/);
  });

  it('adapted tool catches errors', async () => {
    const badTool = {
      name: 'boom',
      description: 'boom',
      input_schema: { type: 'object', properties: {} },
      execute: async () => { throw new Error('kaboom'); }
    };
    const ctx = { senderId: 'u', chatId: 'c' };
    const adapted = adaptTools([badTool], ctx);
    const result = await adapted[0].execute({});
    assert.match(result, /kaboom/);
  });
});
