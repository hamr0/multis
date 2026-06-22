const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getPlatform } = require('../src/tools/platform');
const { TOOLS } = require('../src/tools/definitions');
const { buildToolRegistry, getToolsForUser, DEFAULT_OWNER_ONLY } = require('../src/tools/registry');
const { adaptTools } = require('../src/tools/adapter');
const { setMultisDir, PATHS } = require('../src/config');

// Tool executions audit-log (open_url/clipboard/exec/...). Without this redirect
// they resolve to the REAL ~/.multis/logs/audit.log and pollute the live account
// (the desktop-injection test below alone wrote hundreds of lines). Sandbox the
// whole file so any audit write during tests lands in a throwaway dir.
let _toolsSandbox;
before(() => { _toolsSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-tools-sandbox-')); setMultisDir(_toolsSandbox); });
after(() => { setMultisDir(null); fs.rmSync(_toolsSandbox, { recursive: true, force: true }); });

// Regression guard: kept FIRST so it runs with only the file-level redirect
// active. If that redirect is ever removed, audit paths resolve back to the real
// home and this fails — exactly the leak we are closing.
describe('test isolation — audit writes stay out of the real ~/.multis', () => {
  it('resolves the audit log under the sandbox, never the real home', () => {
    const real = path.join(os.homedir(), '.multis');
    const auditPath = PATHS.auditLog();
    assert.ok(!auditPath.startsWith(real), `audit log must not resolve to the real home, got ${auditPath}`);
    assert.ok(auditPath.startsWith(_toolsSandbox), `audit log should be under the sandbox, got ${auditPath}`);
  });
});

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

describe('getPlatform', () => {
  it('returns linux, macos, or unknown (never crashes)', () => {
    const result = getPlatform();
    assert.ok(['linux', 'macos', 'unknown'].includes(result));
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
    const valid = new Set(['linux', 'macos']);
    for (const tool of TOOLS) {
      for (const p of tool.platforms) {
        assert.ok(valid.has(p), `${tool.name} has invalid platform: ${p}`);
      }
    }
  });

  it('no android-only tools remain (Termux support removed)', () => {
    const androidOnly = TOOLS.filter(t => t.platforms.includes('android'));
    assert.strictEqual(androidOnly.length, 0, `unexpected android tools: ${androidOnly.map(t => t.name)}`);
  });

  it('universal tools support linux and macos', () => {
    const universal = TOOLS.filter(t => t.name === 'exec' || t.name === 'search_docs' || t.name === 'remember');
    for (const t of universal) {
      assert.ok(t.platforms.includes('linux'), `${t.name} missing linux`);
      assert.ok(t.platforms.includes('macos'), `${t.name} missing macos`);
    }
  });

  it('find_files matches by case-insensitive substring (finds name+extension)', async () => {
    // Regression: a `name` without the extension used to miss (exact `-name`).
    // "my-resume-doc" must now locate "My-Resume-Doc.txt".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-find-'));
    fs.writeFileSync(path.join(dir, 'My-Resume-Doc.txt'), 'x');
    const findFiles = TOOLS.find(t => t.name === 'find_files');
    const out = await findFiles.execute({ name: 'my-resume-doc', path: dir }, { senderId: 'u' });
    assert.match(out, /My-Resume-Doc\.txt/, 'substring + case-insensitive match should find the file');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('find_files honors an explicit glob as-is', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-find-'));
    fs.writeFileSync(path.join(dir, 'a.pdf'), 'x');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
    const findFiles = TOOLS.find(t => t.name === 'find_files');
    const out = await findFiles.execute({ name: '*.pdf', path: dir }, { senderId: 'u' });
    assert.match(out, /a\.pdf/);
    assert.doesNotMatch(out, /b\.txt/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('find_files does not execute shell substitution in the name arg', async () => {
    // Security regression: name was interpolated into a bash string via
    // JSON.stringify (which does NOT escape $ or backticks), so `$(...)` ran.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-find-'));
    const sentinel = path.join(dir, 'pwned_find');
    const findFiles = TOOLS.find(t => t.name === 'find_files');
    await findFiles.execute({ name: `$(touch ${sentinel})`, path: dir }, { senderId: 'u' });
    assert.ok(!fs.existsSync(sentinel), 'shell substitution in name must NOT execute');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('grep_files does not execute shell injection in pattern/options', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-grep-'));
    fs.writeFileSync(path.join(dir, 'f.txt'), 'hello');
    const sentinelP = path.join(dir, 'pwned_grep_pattern');
    const sentinelO = path.join(dir, 'pwned_grep_opts');
    const grepFiles = TOOLS.find(t => t.name === 'grep_files');
    // injection via pattern ($()) and via the free-form options string (`;`)
    await grepFiles.execute({ pattern: `x$(touch ${sentinelP})`, path: dir }, { senderId: 'u' });
    await grepFiles.execute({ pattern: 'x', path: dir, options: `; touch ${sentinelO} #` }, { senderId: 'u' });
    assert.ok(!fs.existsSync(sentinelP), 'shell substitution in pattern must NOT execute');
    assert.ok(!fs.existsSync(sentinelO), 'shell metachar in options must NOT execute');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('media_control rejects a non-enum action and does NOT execute it (RCE regression)', async () => {
    // Security regression: `playerctl ${action}` was interpolated into /bin/bash
    // (execCommand), and the schema enum is not enforced at the adapter — so
    // action:"pause; touch X" ran arbitrary commands. Now enum-validated + execArgv.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-media-'));
    const sentinel = path.join(dir, 'pwned_media');
    const media = TOOLS.find(t => t.name === 'media_control');
    const ctx = { senderId: 'u', runtimePlatform: 'linux' };
    const out = await media.execute({ action: `pause; touch ${sentinel}` }, ctx);
    assert.ok(!fs.existsSync(sentinel), 'injected command in media_control action must NOT execute');
    assert.match(out, /Invalid action/i, 'a non-enum action is rejected');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('find_files: a leading-dash path cannot become a find action (-delete regression)', async () => {
    // Security regression: `dir` was find's first argv token with no `--`, so
    // path:"-delete" parsed as the -delete ACTION (find with no path → cwd),
    // recursively deleting. We sandbox cwd so the UNFIXED behavior (the red phase)
    // only ever hits the throwaway tmp dir, never the repo.
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-fdel-'));
    const victim = path.join(sandbox, 'keep.txt');
    fs.writeFileSync(victim, 'data');
    const findFiles = TOOLS.find(t => t.name === 'find_files');
    const origCwd = process.cwd();
    try {
      process.chdir(sandbox);
      const out = await findFiles.execute({ name: '*', path: '-delete' }, { senderId: 'u' });
      assert.match(out, /Invalid path/i, 'a path find could read as an option is rejected');
    } finally {
      process.chdir(origCwd);
    }
    assert.ok(fs.existsSync(victim), 'a -delete path must NOT delete files (find action injection)');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('grep_files rejects an unsupported option flag (flag-injection regression)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-grepf-'));
    fs.writeFileSync(path.join(dir, 'f.txt'), 'hello');
    const grepFiles = TOOLS.find(t => t.name === 'grep_files');
    // `-f <file>` / `--include` / `-r /` are read-amplification / behavior-change
    // vectors; only the safe combinable short flags are permitted.
    const bad = await grepFiles.execute({ pattern: 'x', path: dir, options: '-f /etc/passwd' }, { senderId: 'u' });
    assert.match(bad, /Unsupported grep option/i);
    // a normal flag still works
    const ok = await grepFiles.execute({ pattern: 'hello', path: dir, options: '-rn' }, { senderId: 'u' });
    assert.match(ok, /hello/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('desktop tools do not execute shell injection in their string args', async () => {
    // open_url/wifi go through execArgv (no shell); clipboard/screenshot use a
    // shell but shq()-quote the user value. Either way `$()` must stay inert.
    // The underlying binaries may be absent — that is fine; we assert only that
    // the injected sentinel never gets created.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-desk-'));
    const mk = (n) => path.join(dir, n);
    const ctx = { senderId: 'u', runtimePlatform: 'linux' };
    const get = (n) => TOOLS.find(t => t.name === n);

    await get('open_url').execute({ url: `$(touch ${mk('pwned_url')})` }, ctx);
    await get('clipboard').execute({ action: 'set', text: `$(touch ${mk('pwned_clip')})` }, ctx);
    await get('screenshot').execute({ output: `/tmp/x$(touch ${mk('pwned_shot')}).png` }, ctx);
    await get('wifi').execute({ action: 'connect', ssid: `$(touch ${mk('pwned_wifi')})` }, ctx);

    for (const n of ['pwned_url', 'pwned_clip', 'pwned_shot', 'pwned_wifi']) {
      assert.ok(!fs.existsSync(mk(n)), `injection via ${n} must NOT execute`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

describe('buildToolRegistry', () => {
  it('filters by platform', () => {
    const linuxTools = buildToolRegistry({}, 'linux');
    const macosTools = buildToolRegistry({}, 'macos');

    // Both desktop platforms get exec; an unknown platform gets nothing.
    assert.ok(linuxTools.find(t => t.name === 'exec'));
    assert.ok(macosTools.find(t => t.name === 'exec'));
    // wifi/brightness are desktop-only (linux+macos); no android remains.
    assert.ok(linuxTools.find(t => t.name === 'wifi'));
    assert.strictEqual(buildToolRegistry({}, 'android').length, 0, 'android is no longer a target platform');
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
    // customer-safe tools remain visible
    assert.ok(userTools.find(t => t.name === 'search_docs'), 'non-owner should see search_docs');
  });

  it('respects config override for owner_only', () => {
    const allTools = buildToolRegistry({}, 'linux');
    const config = { tools: { exec: { enabled: true, owner_only: false } } };
    const userTools = getToolsForUser(allTools, false, config);
    assert.ok(userTools.find(t => t.name === 'exec'), 'exec with owner_only:false should be visible');
  });

  it('FORCE_OWNER_ONLY host tools cannot be re-exposed to non-owners via config', () => {
    const allTools = buildToolRegistry({}, 'linux');
    // A stale tools.json trying to grant host tools to customers must not win.
    const config = { tools: {
      send_file: { enabled: true, owner_only: false },
      open_url: { enabled: true, owner_only: false },
      system_info: { enabled: true, owner_only: false },
      notify: { enabled: true, owner_only: false },
      media_control: { enabled: true, owner_only: false },
    } };
    const userTools = getToolsForUser(allTools, false, config);
    for (const name of ['send_file', 'open_url', 'system_info', 'notify', 'media_control']) {
      assert.ok(!userTools.find(t => t.name === name), `non-owner must not see ${name}`);
    }
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
