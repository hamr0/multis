'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createGate, buildGateConfig, translateAction, ownerCheck, isCatastrophic, commandHead, makeDestructiveCheck } = require('../src/governance/gate');

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
  it('bash.allow = allowlist ∪ denylist (denylist = permitted-after-ceremony, must pass the floor)', () => {
    // M9 increment 3: the denylist is SEVERITY classification, not permission.
    // Its commands must pass the Axis-A floor to *reach* the core's ceremony, so
    // they're admitted to bash.allow alongside the benign allowlist. A command in
    // neither list stays unpermitted (floor denies it).
    const cfg = buildGateConfig({ governance: GOV });
    assert.deepStrictEqual(cfg.bash.allow, ['ls', 'pwd', 'cat', 'grep', 'git', 'rm', 'sudo', 'dd', 'shutdown']);
  });

  it('no bash.denyPatterns — severity (destructive/catastrophic) is classified+ceremonied in the M9 core, not denied here', () => {
    const cfg = buildGateConfig({ governance: GOV });
    assert.strictEqual(cfg.bash.denyPatterns, undefined);
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

  it('maps limits.maxToolRounds 1:1 from security.max_tool_rounds (bareguard 0.4.2 ticks only on tool records)', () => {
    const cfg = buildGateConfig({
      governance: GOV,
      security: { max_tool_rounds: 7 },
    });
    assert.strictEqual(cfg.limits.maxToolRounds, 7);
  });

  it('llm.max_tool_rounds takes precedence over security.max_tool_rounds', () => {
    const cfg = buildGateConfig({
      governance: GOV,
      llm: { max_tool_rounds: 3 },
      security: { max_tool_rounds: 99 },
    });
    assert.strictEqual(cfg.limits.maxToolRounds, 3);
  });
});

describe('translateAction — multis tool names → bareguard canonical', () => {
  // Verbatim args form: bareguard 0.4.1+ reads cmd/path from action.args via
  // fallback, so the translator only maps the type — no field hoisting.
  it('exec → {type:"bash", args, _ctx}', () => {
    const a = translateAction('exec', { command: 'ls -la' }, { senderId: 'u1' });
    assert.strictEqual(a.type, 'bash');
    assert.deepStrictEqual(a.args, { command: 'ls -la' });
    assert.strictEqual(a._ctx.senderId, 'u1');
  });

  it('read_file → {type:"read", args:{path}, _ctx}', () => {
    const a = translateAction('read_file', { path: '/tmp/x' }, { chatId: 'c1' });
    assert.strictEqual(a.type, 'read');
    assert.strictEqual(a.args.path, '/tmp/x');
    assert.strictEqual(a._ctx.chatId, 'c1');
  });

  it('grep_files / find_files → {type:"read", args:{path}}', () => {
    const g = translateAction('grep_files', { pattern: 'foo', path: '/tmp' });
    assert.strictEqual(g.type, 'read');
    assert.strictEqual(g.args.path, '/tmp');
    assert.strictEqual(g.args.pattern, 'foo');
    const f = translateAction('find_files', { name: '*.js', path: '/tmp' });
    assert.strictEqual(f.type, 'read');
    assert.strictEqual(f.args.path, '/tmp');
  });

  it('send_file → {type:"read", args:{path}} so fs.deny gates the read', () => {
    const a = translateAction('send_file', { path: '/etc/shadow' });
    assert.strictEqual(a.type, 'read');
    assert.strictEqual(a.args.path, '/etc/shadow');
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

  it('non-owner denied send_file (no file exfiltration to customers)', () => {
    const r = ownerCheck('send_file', { isOwner: false });
    assert.match(r, /owner privileges/);
    assert.strictEqual(ownerCheck('send_file', { isOwner: true }), null);
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
      // checkpoint_tools: [] opts out of the always-ask flags layer so these
      // tests exercise allowlist/deny MECHANICS directly (the always-ask path is
      // covered separately below).
      config: { security: { max_cost_per_run: 1.00, checkpoint_tools: [] } },
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

  it('destructive exec PASSES the thin floor for the owner (allow ∪ denylist) — the ceremony is in the M9 core, not policy', async () => {
    // M9 increment 3: policy is now just the Axis-A floor. A destructive command
    // is admitted to bash.allow so it passes the floor (verdict true) and the
    // core's classifier + PIN ceremony gate it on execute — NOT here. (The
    // ceremony itself is covered by govern.test.js + the Loop-path tests.)
    // NB: a non-recursive `rm <file>` — `rm -rf /…` is independently content-denied
    // by bareguard's floor, which is intentional (see the catastrophic-wall tests).
    const verdict = await bundle.policy('exec', { command: 'rm /home/testuser/Documents/old.txt' }, { isOwner: true, senderId: 'u1', chatId: 'c1' });
    assert.strictEqual(verdict, true);
  });

  it('an UNKNOWN command (neither list) is still floor-denied for the owner', async () => {
    const verdict = await bundle.policy('exec', { command: 'make all' }, { isOwner: true, senderId: 'u1', chatId: 'c1' });
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

  // Defense-in-depth: the secret-store / credential deny entries (shipped in the
  // template) must actually fence the file tools — including when the model emits a
  // `~`-form path, which the translator expands so it matches the (~-expanded) deny
  // entry. Proves the expansion + prefix-deny combination, not just the mechanism.
  it('fs.deny fences the secret store + ~/.ssh, even via a ~-form path', async () => {
    const home = process.env.HOME;
    const b = await createGate({
      config: { security: { max_cost_per_run: 1.0, checkpoint_tools: [] } },
      governance: { commands: GOV.commands, paths: { allowed: ['/'], denied: ['~/.multis/config.json', '~/.ssh', '/etc/shadow'] } },
      fileless: true,
      humanPrompt: async () => ({ decision: 'deny' }),
    });
    // ~-form read of the secret store → expanded → matches the deny entry.
    assert.match(await b.policy('read_file', { path: '~/.multis/config.json' }, { isOwner: true }), /\[deny:/);
    assert.match(await b.policy('read_file', { path: `${home}/.multis/config.json` }, { isOwner: true }), /\[deny:/);
    // ~/.ssh fences files INSIDE it (prefix match), and grep_files (content read) too.
    assert.match(await b.policy('read_file', { path: '~/.ssh/id_rsa' }, { isOwner: true }), /\[deny:/);
    assert.match(await b.policy('grep_files', { pattern: 'x', path: '~/.ssh' }, { isOwner: true }), /\[deny:/);
    // a NON-denied read still passes (the fence isn't over-broad).
    assert.strictEqual(await b.policy('read_file', { path: `${home}/Documents/notes.txt` }, { isOwner: true }), true);
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

describe('createGate — always-ask (flags) is now opt-in', () => {
  // Under the obedient command-governance model, blanket confirm-before-every-exec
  // is OFF by default (friction is per-tier in policy: destructive→PIN). The flags
  // primitive (flags:{type:{bash:'ask'}}) is still available via checkpoint_tools.

  it('by default (no checkpoint_tools) a benign allowlisted exec runs WITHOUT asking', async () => {
    const asked = [];
    const bundle = await createGate({
      config: {}, // no checkpoint_tools → default [] → no blanket ask
      governance: GOV,
      fileless: true,
      humanPrompt: async (event) => { asked.push(event); return { decision: 'allow' }; },
    });
    const verdict = await bundle.policy('exec', { command: 'ls' }, { isOwner: true, chatId: 'c1', senderId: 'u1' });
    assert.strictEqual(asked.length, 0, 'no blanket ask by default');
    assert.strictEqual(verdict, true, 'benign exec proceeds silently');
  });

  it('checkpoint_tools:["exec"] re-enables the always-ask (fires before the allowlist)', async () => {
    const asked = [];
    const bundle = await createGate({
      config: { security: { checkpoint_tools: ['exec'] } },
      governance: GOV,
      fileless: true,
      humanPrompt: async (event) => { asked.push(event); return { decision: 'allow' }; },
    });
    const verdict = await bundle.policy('exec', { command: 'ls' }, { isOwner: true, chatId: 'c1', senderId: 'u1' });
    assert.strictEqual(asked.length, 1, 'opt-in ask fires for the allowlisted exec');
    assert.match(asked[0].rule || '', /flags\.type/, 'ask raised by the flags.type primitive');
    assert.strictEqual(verdict, true, 'approve → exec proceeds');
  });

  it('deny at the ask blocks the exec (when enabled)', async () => {
    const bundle = await createGate({
      config: { security: { checkpoint_tools: ['exec'] } },
      governance: GOV,
      fileless: true,
      humanPrompt: async () => ({ decision: 'deny' }),
    });
    const verdict = await bundle.policy('exec', { command: 'ls' }, { isOwner: true, chatId: 'c1' });
    assert.notStrictEqual(verdict, true, 'deny at the ask → not allowed');
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

describe('createGate — thin Axis-A floor (M9 increment 3: the severity ceremony moved to the core)', () => {
  // policy() is now just the deterministic floor the bare-agent Loop calls before
  // a tool: owner-bypass + wireGate.policy (allowlist/fs.deny/secrets/budget/rounds).
  // The destructive/catastrophic PIN(+CONFIRM) ceremony NO LONGER lives here — it's
  // in runGovernedAction (covered by govern.test.js + the Loop-path tests in
  // handlers.test.js). createGate no longer consumes pin/confirm challenges, so a
  // ceremony-bearing command just PASSES the floor (it's admitted to bash.allow via
  // allowlist ∪ denylist) and the core gates it on execute.
  let bundle;
  const ctx = { isOwner: true, senderId: 'u1', chatId: 'c1', platform: 'telegram' };

  before(async () => {
    bundle = await createGate({
      config: { security: { checkpoint_tools: [] } },
      governance: GOV, // denylist: rm, sudo, dd, shutdown
      fileless: true,
      humanPrompt: async () => ({ decision: 'deny' }),
    });
  });

  it('benign exec (ls) passes the floor', async () => {
    assert.strictEqual(await bundle.policy('exec', { command: 'ls -la' }, ctx), true);
  });

  it('an in-scope read passes the floor', async () => {
    assert.strictEqual(await bundle.policy('read_file', { path: '/home/testuser/Documents/notes.txt' }, ctx), true);
  });

  it('a destructive command PASSES the floor (reaches the core ceremony) — not gated here', async () => {
    assert.strictEqual(await bundle.policy('exec', { command: 'rm /home/testuser/Documents/old.txt' }, ctx), true);
    assert.strictEqual(await bundle.policy('exec', { command: 'sudo systemctl restart x' }, ctx), true);
  });

  it('catastrophic shapes that slip past bareguard pass the floor (the CORE walls them on execute)', async () => {
    // The core hard-walls these (govern.test.js); the floor itself only sees them
    // as in-allowlist commands. `dd`/`mkfs`/`rm -rf ~/*` don't match bareguard's
    // built-in content rule, so they reach the core where the wall lives.
    assert.strictEqual(await bundle.policy('exec', { command: 'dd if=/dev/zero of=/dev/sda' }, ctx), true);
    assert.strictEqual(await bundle.policy('exec', { command: 'rm -rf ~/*' }, ctx), true);
  });

  it("bareguard's own floor independently HARD-DENIES `rm -rf /…` (complementary to the core wall)", async () => {
    assert.match(await bundle.policy('exec', { command: 'rm -rf /' }, ctx), /\[deny:/);
    assert.match(await bundle.policy('exec', { command: 'rm -rf /var/data' }, ctx), /\[deny:/);
  });

  it('an unknown command (neither list) is floor-denied', async () => {
    assert.match(await bundle.policy('exec', { command: 'make all' }, ctx), /\[deny:/);
  });

  it('a read of a denied path is floor-denied', async () => {
    assert.match(await bundle.policy('read_file', { path: '/etc/passwd' }, ctx), /\[deny:/);
  });

  it('non-owner is denied by ownerCheck (no shell tool reaches the floor)', async () => {
    const verdict = await bundle.policy('exec', { command: 'ls' }, { isOwner: false, senderId: 'cust', chatId: 'c2', platform: 'beeper' });
    assert.match(verdict, /owner privileges/);
  });
});

describe('command-governance detection helpers', () => {
  const isDestructive = makeDestructiveCheck(['rm', 'sudo', 'dd', 'chmod', 'kill', 'shutdown']);

  it('commandHead skips sudo/env and a path prefix', () => {
    assert.strictEqual(commandHead('sudo rm -rf /'), 'rm');
    assert.strictEqual(commandHead('/usr/bin/ls -la'), 'ls');
    assert.strictEqual(commandHead('  git status'), 'git');
  });

  it('isDestructive flags denylist heads and bare sudo', () => {
    assert.ok(isDestructive('rm foo.txt'));
    assert.ok(isDestructive('sudo whoami'), 'bare sudo is destructive');
    assert.ok(isDestructive('chmod 777 x'));
    assert.ok(!isDestructive('ls -la'));
    assert.ok(!isDestructive('git commit'));
  });

  it('isCatastrophic flags machine-wreckers only', () => {
    assert.ok(isCatastrophic('rm -rf /'));
    assert.ok(isCatastrophic('rm -rf /*'));
    assert.ok(isCatastrophic('rm -rf ~'));
    assert.ok(isCatastrophic('rm -fr $HOME'));
    assert.ok(isCatastrophic('dd if=/dev/zero of=/dev/sda'));
    assert.ok(isCatastrophic('mkfs.ext4 /dev/sdb1'));
    assert.ok(isCatastrophic('shutdown -h now'));
    assert.ok(isCatastrophic(':(){ :|:& };:'));
    // NOT catastrophic — ordinary destructive (PIN tier), not CONFIRM:
    assert.ok(!isCatastrophic('rm -rf /home/testuser/Projects/build'));
    assert.ok(!isCatastrophic('rm old.txt'));
    assert.ok(!isCatastrophic('chmod 644 file'));
  });
});
