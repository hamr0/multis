/**
 * M0 — door-convergence parity net (M9, PRD §F gate/exit).
 *
 * M9's load-bearing claim is "one governed core, both doors": however a host
 * action is requested, it resolves to a declared capability and runs through the
 * SINGLE governed core (runGovernedAction) — owner floor → arg-validation →
 * Axis-A → classify severity → ceremony → execute → audit. The two BUILT doors are:
 *   - the slash door  (`/exec <cmd>` → dispatchCapability('run_shell'))
 *   - the LLM door     (the model's `exec` tool call → wrapToolThroughCore)
 *
 * Each door's ceremony is already tested in isolation (handlers.test.js for the
 * slash door, agent-loop.test.js for the LLM door). What those don't prove is that
 * the two doors CONVERGE: given the SAME command + the SAME governance, do they
 * produce the SAME governed record? This net drives both with one command and one
 * gov config and asserts byte-identical outcomes — the convergence itself.
 *
 * NOT covered here (honest scope): the natural-language door ("silence Amr" → an
 * app-verb) was POC-validated but never wired into the live path — app-verbs are
 * not exposed to the LLM, so plain text routes to /ask, not to a capability. When
 * that door is built it joins this net as a third column. The set_mode picker→core
 * convergence is covered by govern.test.js + the commitMode tests in handlers.test.js.
 */

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createMessageRouter } = require('../../src/bot/handlers');
const { createTestEnv, mockPlatform, mockLLM, mockToolProvider, msg } = require('../helpers/setup');
const { PinManager, hashPin } = require('../../src/security/pin');
const { PendingRegistry } = require('../../src/bot/pending');
const { readAuditLogs } = require('../../src/governance/audit');

const PIN = '1234';

// One governance config for BOTH doors:
//  - echo ∈ allowlist ∪ denylist → Axis-A floor permits it, the core classifies it
//    DESTRUCTIVE (denylist membership). Running `echo` is harmless + deterministic,
//    so "it executed" is observable without a real mutation.
//  - rm ∈ denylist → floor permits it (bash.allow = allowlist ∪ denylist), so a
//    catastrophic `rm` reaches the multis CORE wall rather than being stopped at the
//    bareguard floor — proving the wall the same way agent-loop.test.js does.
const GOV = { commands: { allowlist: ['echo'], denylist: ['echo', 'rm'] }, paths: { allowed: ['.*'], denied: [] } };

const DESTRUCTIVE = 'echo parity-marker';
// Catastrophic-classified (`~/*` matches CATASTROPHIC_ROOT_TARGET) AND passes the
// bareguard floor — so it reaches the multis CORE wall, not a floor deny (the same
// command agent-loop.test.js uses to prove the wall; `$HOME` is rejected earlier by
// bareguard's shell-metachar guard). The slash door runs the REAL exec, so its test
// redirects HOME to throwaway scratch — a wall regression could then only `rm` an
// empty temp dir, never the real home.
const CATASTROPHIC = 'rm -rf ~/*';

const flush = () => new Promise((r) => setImmediate(r));
async function waitFor(pred, label = 'condition', tries = 500) {
  for (let i = 0; i < tries; i++) { if (pred()) return; await flush(); }
  throw new Error(`waitFor timed out: ${label}`);
}

function stubIndexer() {
  return {
    search: () => [],
    indexFile: async () => 0,
    indexBuffer: async () => 0,
    recallMemory: async () => [],
    rememberEpisode: async () => ({}),
    rememberFact: async () => ({}),
    promotionSweep: async () => 0,
    forgetMemory: async () => 0,
    getStats: () => ({ indexedFiles: 0, totalChunks: 0, byType: {} }),
    store: { recordSearchAccess: () => {} },
  };
}

// A stub `exec` (owner-only by name) that records what it ran instead of touching
// the machine — the agent path executes through this, so "did it run?" is
// observable without a real mutation.
function execStub(ran) {
  return {
    name: 'exec', description: 'Run a shell command', platforms: ['linux'], owner_only: true,
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (args) => { ran.push(args.command); return `ran: ${args.command}`; },
  };
}

const securityCfg = () => ({ pin_hash: hashPin(PIN), pin_timeout_hours: 24, checkpoint_tools: [] });

// Slash door: real tool registry (the genuine `exec`), driven by /exec.
function buildSlash() {
  const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1', security: securityCfg() });
  const platform = mockPlatform();
  const pinManager = new PinManager(env.config); pinManager.sessions = {};
  const router = createMessageRouter(env.config, {
    llm: mockLLM(), indexer: stubIndexer(), pinManager, pending: new PendingRegistry(),
    fileless: true, governanceFile: GOV,
  });
  router.registerPlatform('telegram', platform);
  return { env, platform, router };
}

// LLM door: the model emits an `exec` tool call; the stub records execution.
function buildLLM(command, ran) {
  const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1', security: securityCfg() });
  const platform = mockPlatform();
  const pinManager = new PinManager(env.config); pinManager.sessions = {};
  const provider = mockToolProvider([
    { text: '', toolCalls: [{ id: 't1', name: 'exec', arguments: { command } }] },
    { text: 'done.', toolCalls: [] },
  ]);
  const router = createMessageRouter(env.config, {
    provider, indexer: stubIndexer(), tools: [execStub(ran)], toolsConfig: {}, runtimePlatform: 'linux',
    pinManager, pending: new PendingRegistry(), fileless: true, governanceFile: GOV,
  });
  router.registerPlatform('telegram', platform);
  return { env, platform, router };
}

// The canonical "what happened" record both doors write through the core's audit dep.
function lastGovern(tier) {
  return readAuditLogs(500).filter((e) => e.action === 'govern' && e.tier === tier).pop();
}
const pinPrompt = (p) => p.sent.find((s) => /PIN/i.test(s.text));
const ranSomeOutput = (p, re) => p.sent.some((s) => !/PIN/i.test(s.text) && re.test(s.text));

describe('M0 parity — slash door and LLM door converge on the one governed core', () => {
  it('destructive: both doors echo the SAME verbatim command, run only on the correct PIN, and record the SAME govern intent', async () => {
    // --- slash door ---
    const slash = buildSlash();
    const sp = slash.router(msg(`/exec ${DESTRUCTIVE}`), slash.platform);
    await waitFor(() => pinPrompt(slash.platform), 'slash PIN prompt');
    const slashEcho = pinPrompt(slash.platform).text;
    await slash.router(msg(PIN), slash.platform);
    await sp;
    assert.ok(ranSomeOutput(slash.platform, /parity-marker/), 'slash command ran after the PIN');
    const slashGovern = lastGovern('destructive');
    slash.env.cleanup();

    // --- LLM door (identical command) ---
    const ran = [];
    const llm = buildLLM(DESTRUCTIVE, ran);
    const lp = llm.router(msg('/ask do the thing'), llm.platform);
    await waitFor(() => pinPrompt(llm.platform), 'llm PIN prompt');
    const llmEcho = pinPrompt(llm.platform).text;
    assert.deepStrictEqual(ran, [], 'llm command did NOT run before the PIN');
    await llm.router(msg(PIN), llm.platform);
    await lp;
    assert.deepStrictEqual(ran, [DESTRUCTIVE], 'llm command ran after the PIN');
    const llmGovern = lastGovern('destructive');
    llm.env.cleanup();

    // --- PARITY ---
    // Both ceremonies echoed the VERBATIM resolved command (not a model intent).
    assert.match(slashEcho, /echo parity-marker/);
    assert.match(llmEcho, /echo parity-marker/);
    // Both doors classified identically and wrote the identical plain-language intent.
    assert.ok(slashGovern && llmGovern, 'both doors recorded a govern audit line');
    assert.strictEqual(slashGovern.tier, 'destructive');
    assert.strictEqual(slashGovern.tier, llmGovern.tier);
    assert.strictEqual(slashGovern.capability, llmGovern.capability);
    assert.strictEqual(slashGovern.capability, 'run_shell');
    assert.strictEqual(slashGovern.intent, llmGovern.intent);
    assert.strictEqual(slashGovern.intent, '[destructive] run_shell: echo parity-marker');
  });

  it('catastrophic: both doors HARD-WALL — no PIN ceremony, the command never runs', async () => {
    // --- slash door --- (real exec; redirect HOME so a wall regression can only
    // touch empty scratch, never the real home)
    const slash = buildSlash();
    const realHome = process.env.HOME;
    process.env.HOME = path.join(slash.env.tmpDir, 'scratch-home');
    fs.mkdirSync(process.env.HOME, { recursive: true });
    try {
      await slash.router(msg(`/exec ${CATASTROPHIC}`), slash.platform);
    } finally {
      process.env.HOME = realHome;
    }
    assert.ok(!pinPrompt(slash.platform), 'slash: a wall is not a ceremony — no PIN prompt');
    assert.ok(slash.platform.sent.some((s) => /too destructive|terminal|blocked/i.test(s.text)),
      'slash: the owner got the hard-wall message');
    // The wall is recorded as a BLOCK, not an execution (audit fidelity).
    const slashGovern = lastGovern('catastrophic');
    assert.ok(slashGovern && slashGovern.status === 'blocked', 'slash: catastrophic audited status=blocked');
    slash.env.cleanup();

    // --- LLM door (identical command) ---
    const ran = [];
    const llm = buildLLM(CATASTROPHIC, ran);
    await llm.router(msg('/ask wipe it'), llm.platform);
    assert.ok(!pinPrompt(llm.platform), 'llm: no PIN for a wall');
    assert.deepStrictEqual(ran, [], 'llm: the catastrophic command never ran');
    const llmGovern = lastGovern('catastrophic');
    assert.ok(llmGovern && llmGovern.status === 'blocked', 'llm: catastrophic audited status=blocked');
    llm.env.cleanup();
  });

  it('declined PIN: both doors refuse the destructive action — neither executes', async () => {
    // A wrong PIN with attempts remaining re-parks the ceremony (retry-able) on both
    // doors — NOT a terminal cancel — so the message is "attempts remaining". The
    // load-bearing invariant is unchanged: neither door executes on a wrong PIN.
    // --- slash door, wrong PIN ---
    const slash = buildSlash();
    const sp = slash.router(msg(`/exec ${DESTRUCTIVE}`), slash.platform);
    await waitFor(() => pinPrompt(slash.platform), 'slash PIN prompt');
    await slash.router(msg('9999'), slash.platform); // wrong
    await sp;
    assert.ok(slash.platform.sent.some((s) => /attempts remaining/i.test(s.text)), 'slash: wrong PIN → retry-able');
    assert.ok(!ranSomeOutput(slash.platform, /parity-marker/), 'slash: command did NOT execute');
    slash.env.cleanup();

    // --- LLM door, wrong PIN ---
    const ran = [];
    const llm = buildLLM(DESTRUCTIVE, ran);
    const lp = llm.router(msg('/ask do the thing'), llm.platform);
    await waitFor(() => pinPrompt(llm.platform), 'llm PIN prompt');
    await llm.router(msg('9999'), llm.platform); // wrong
    await lp;
    assert.deepStrictEqual(ran, [], 'llm: command did NOT execute on a wrong PIN');
    llm.env.cleanup();
  });
});
