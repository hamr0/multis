'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createGate, buildGateConfig, translateAction, ownerCheck } = require('../src/governance/gate');

const GOV = {
  commands: {
    allowlist: ['ls', 'pwd', 'cat', 'grep', 'git'],
    denylist: ['rm', 'sudo', 'dd', 'shutdown'],
  },
  paths: {
    allowed: ['/home/testuser/Documents', '/home/testuser/Projects'],
    denied: ['/etc', '/var', '/usr', '/bin'],
  },
};

describe('buildGateConfig — governance.json → bareguard config mapping', () => {
  it('maps commands.allowlist to bash.allow', () => {
    const cfg = buildGateConfig({ governance: GOV });
    assert.deepStrictEqual(cfg.bash.allow, ['ls', 'pwd', 'cat', 'grep', 'git']);
  });

  it('maps commands.denylist to bash.denyPatterns regexes', () => {
    const cfg = buildGateConfig({ governance: GOV });
    assert.ok(Array.isArray(cfg.bash.denyPatterns));
    assert.strictEqual(cfg.bash.denyPatterns.length, 4);
    assert.ok(cfg.bash.denyPatterns[0].test('rm -rf /'));
    assert.ok(cfg.bash.denyPatterns[1].test('sudo whoami'));
  });

  it('maps paths.allowed to fs.readScope and fs.writeScope', () => {
    const cfg = buildGateConfig({ governance: GOV });
    assert.deepStrictEqual(cfg.fs.readScope, GOV.paths.allowed);
    assert.deepStrictEqual(cfg.fs.writeScope, GOV.paths.allowed);
  });

  it('maps paths.denied to fs.deny', () => {
    const cfg = buildGateConfig({ governance: GOV });
    assert.deepStrictEqual(cfg.fs.deny, GOV.paths.denied);
  });

  it('configures secrets envVars + patterns', () => {
    const cfg = buildGateConfig({ governance: GOV });
    assert.ok(cfg.secrets.envVars.includes('ANTHROPIC_API_KEY'));
    assert.ok(cfg.secrets.envVars.includes('TELEGRAM_BOT_TOKEN'));
    assert.ok(cfg.secrets.patterns.some(re => re.test('sk-' + 'a'.repeat(40))));
  });

  it('injection patterns land in content.askPatterns', () => {
    const cfg = buildGateConfig({ governance: GOV });
    assert.ok(Array.isArray(cfg.content.askPatterns));
    assert.ok(cfg.content.askPatterns.some(re => re.test('ignore all previous instructions')));
    assert.ok(cfg.content.askPatterns.some(re => re.test('jailbreak now')));
  });

  it('maps budget.maxCostUsd from security.max_cost_per_run', () => {
    const cfg = buildGateConfig({
      governance: GOV,
      budget: { maxCostUsd: 0.50 },
    });
    assert.strictEqual(cfg.budget.maxCostUsd, 0.50);
  });

  it('maps limits.maxTurns from security.max_tool_rounds (doubled — bareguard counts both LLM and tool records)', () => {
    const cfg = buildGateConfig({
      governance: GOV,
      security: { max_tool_rounds: 7 },
    });
    assert.strictEqual(cfg.limits.maxTurns, 14);
  });

  it('llm.max_tool_rounds takes precedence over security.max_tool_rounds', () => {
    const cfg = buildGateConfig({
      governance: GOV,
      llm: { max_tool_rounds: 3 },
      security: { max_tool_rounds: 99 },
    });
    assert.strictEqual(cfg.limits.maxTurns, 6);
  });
});

describe('translateAction — multis tool names → bareguard canonical', () => {
  it('exec → {type:"bash", cmd, args, _ctx}', () => {
    const a = translateAction('exec', { command: 'ls -la' }, { senderId: 'u1' });
    assert.strictEqual(a.type, 'bash');
    assert.strictEqual(a.cmd, 'ls -la');
    assert.deepStrictEqual(a.args, { command: 'ls -la' });
    assert.strictEqual(a._ctx.senderId, 'u1');
  });

  it('read_file → {type:"read", path, args, _ctx}', () => {
    const a = translateAction('read_file', { path: '/tmp/x' }, { chatId: 'c1' });
    assert.strictEqual(a.type, 'read');
    assert.strictEqual(a.path, '/tmp/x');
    assert.strictEqual(a._ctx.chatId, 'c1');
  });

  it('grep_files / find_files → {type:"read", path}', () => {
    const g = translateAction('grep_files', { pattern: 'foo', path: '/tmp' });
    assert.strictEqual(g.type, 'read');
    assert.strictEqual(g.path, '/tmp');
    const f = translateAction('find_files', { name: '*.js', path: '/tmp' });
    assert.strictEqual(f.type, 'read');
    assert.strictEqual(f.path, '/tmp');
  });

  it('unknown tool name passes through as type', () => {
    const a = translateAction('search_docs', { query: 'q' });
    assert.strictEqual(a.type, 'search_docs');
    assert.deepStrictEqual(a.args, { query: 'q' });
  });
});

describe('ownerCheck — multis owner gate', () => {
  it('owner can use shell tools', () => {
    assert.strictEqual(ownerCheck('exec', { isOwner: true }), null);
    assert.strictEqual(ownerCheck('read_file', { isOwner: true }), null);
  });

  it('non-owner denied shell tools', () => {
    const r = ownerCheck('exec', { isOwner: false });
    assert.match(r, /owner privileges/);
  });

  it('non-owner allowed for non-shell tools', () => {
    assert.strictEqual(ownerCheck('search_docs', { isOwner: false }), null);
    assert.strictEqual(ownerCheck('recall_memory', { isOwner: false }), null);
  });
});

describe('createGate — end-to-end with fileless audit', () => {
  let bundle;

  before(async () => {
    bundle = await createGate({
      config: { security: { max_cost_per_run: 1.00 } },
      governance: GOV,
      fileless: true,
      humanPrompt: async () => ({ decision: 'deny' }),
    });
  });

  it('returns the expected bundle', () => {
    assert.ok(bundle.gate);
    assert.strictEqual(typeof bundle.policy, 'function');
    assert.strictEqual(typeof bundle.onLlmResult, 'function');
    assert.strictEqual(typeof bundle.onToolResult, 'function');
    assert.strictEqual(typeof bundle.filterTools, 'function');
  });

  it('policy allows exec ls for owner', async () => {
    const verdict = await bundle.policy('exec', { command: 'ls -la' }, { isOwner: true, senderId: 'u1', chatId: 'c1' });
    assert.strictEqual(verdict, true);
  });

  it('policy denies exec rm for owner via bash.denyPatterns', async () => {
    const verdict = await bundle.policy('exec', { command: 'rm -rf /tmp' }, { isOwner: true });
    assert.strictEqual(typeof verdict, 'string');
    assert.match(verdict, /\[deny:/);
  });

  it('policy denies exec for non-owner regardless of command', async () => {
    const verdict = await bundle.policy('exec', { command: 'ls' }, { isOwner: false });
    assert.match(verdict, /owner privileges/);
  });

  it('policy denies read of denied path', async () => {
    const verdict = await bundle.policy('read_file', { path: '/etc/passwd' }, { isOwner: true });
    assert.match(verdict, /\[deny:/);
  });

  it('audit captures gate decisions in-memory', () => {
    const lines = bundle.gate.audit.entries;
    assert.ok(lines.length > 0);
    assert.ok(lines.some(l => l.phase === 'gate'));
  });

  it('onToolResult records to gate audit with ctx', async () => {
    const before = bundle.gate.audit.entries.length;
    await bundle.onToolResult({
      name: 'exec',
      args: { command: 'ls' },
      result: 'output',
      durationMs: 10,
      ctx: { chatId: 'c1', senderId: 'u1' },
    });
    const after = bundle.gate.audit.entries.length;
    assert.ok(after > before, 'audit entry was emitted');
    const rec = bundle.gate.audit.entries[after - 1];
    assert.strictEqual(rec.phase, 'record');
    assert.strictEqual(rec.action._ctx.chatId, 'c1');
  });

  it('onLlmResult records cost + tokens for budget', async () => {
    const before = bundle.gate.audit.entries.length;
    await bundle.onLlmResult({
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      usage: { inputTokens: 100, outputTokens: 50 },
      costUsd: 0.001,
      durationMs: 200,
      ctx: { chatId: 'c1' },
    });
    const after = bundle.gate.audit.entries.length;
    const rec = bundle.gate.audit.entries[after - 1];
    assert.strictEqual(rec.phase, 'record');
    assert.strictEqual(rec.action.type, 'llm');
    assert.strictEqual(rec.result.costUsd, 0.001);
    assert.strictEqual(rec.result.tokens, 150);
  });
});

describe('createGate — budget halt via humanChannel', () => {
  it('halt triggers humanChannel with event.action carrying _ctx', async () => {
    let captured = null;
    const bundle = await createGate({
      config: {},
      governance: GOV,
      fileless: true,
      budgetFile: null,
      humanPrompt: async (event) => {
        captured = event;
        return { decision: 'deny' };
      },
    });
    // exhaust budget directly
    await bundle.gate.budget.raiseCap('costUsd', 0.001);
    await bundle.onLlmResult({ model: 'm', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0.002, ctx: { chatId: 'c1' } });

    // next check should halt
    try {
      await bundle.policy('exec', { command: 'ls' }, { isOwner: true, chatId: 'c1', senderId: 'u1' });
    } catch (err) {
      // HaltError on halt is fine — we just want to confirm humanChannel saw it
    }
    assert.ok(captured, 'humanChannel was invoked');
    assert.strictEqual(captured.kind, 'halt');
    assert.ok(captured.action, 'halt event carries action (v0.4)');
    assert.strictEqual(captured.action._ctx.chatId, 'c1');
  });
});
