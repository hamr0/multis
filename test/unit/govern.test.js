'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { runGovernedAction, RESULT } = require('../../src/capabilities/govern');

const DENYLIST = ['rm', 'mv', 'chmod', 'chown', 'kill', 'dd', 'sudo'];

// A test deps factory: records what was called, lets each ceremony pass/fail.
// Park-and-resume: the core calls verifyPin ONLY on a resume (ceremonyReply set);
// the first pass returns NEEDS_CEREMONY without verifying. `pin` controls the
// verify verdict; `pinConfigured:false` models "owner set no PIN" (no ceremony).
function makeDeps({ pin = true, pinConfigured = true } = {}) {
  const calls = { verify: 0, execute: 0, audit: [], auditMeta: [], replySeen: null };
  return {
    calls,
    deps: {
      denylist: DENYLIST,
      pinConfigured,
      verifyPin: async (_ctx, reply) => {
        calls.verify += 1; calls.replySeen = reply;
        return pin ? { ok: true } : { ok: false, reason: 'Wrong PIN.' };
      },
      execute: async (cap, args) => { calls.execute += 1; return { ran: cap.name, args }; },
      audit: async (line, meta) => { calls.audit.push(line); calls.auditMeta.push(meta); },
    },
  };
}
const OWNER = { isOwner: true, platform: 'linux', chatId: 'c', senderId: 's' };
const GUEST = { isOwner: false, platform: 'linux', chatId: 'c', senderId: 's' };

test('unknown capability → UNKNOWN, nothing runs', async () => {
  const { deps, calls } = makeDeps();
  const r = await runGovernedAction({ capability: 'nope', args: {}, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.UNKNOWN);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls.execute, 0);
});

test('owner-only floor blocks a non-owner; execute never runs', async () => {
  const { deps, calls } = makeDeps();
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'ls' }, ctx: GUEST, deps });
  assert.strictEqual(r.kind, RESULT.DENIED);
  assert.strictEqual(r.reason, 'owner_only');
  assert.strictEqual(calls.execute, 0);
});

test('missing required arg → NEEDS_ARG (picker), execute never runs', async () => {
  const { deps, calls } = makeDeps();
  const r = await runGovernedAction({ capability: 'set_mode', args: { mode: 'silent' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.NEEDS_ARG);
  assert.deepStrictEqual(r.missing, ['target']);
  assert.strictEqual(calls.execute, 0);
});

test('placeholder arg is treated as missing (model fabrication)', async () => {
  const { deps } = makeDeps();
  const r = await runGovernedAction({ capability: 'index', args: { path: '/path/to/doc.pdf', scope: 'kb' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.NEEDS_ARG);
  assert.ok(r.missing.includes('path'));
});

test('invented enum value → NEEDS_ARG', async () => {
  const { deps } = makeDeps();
  const r = await runGovernedAction({ capability: 'set_mode', args: { target: 'Amr', mode: 'loud' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.NEEDS_ARG);
  assert.ok(r.missing.includes('mode'));
});

test('benign action runs WITHOUT a ceremony', async () => {
  const { deps, calls } = makeDeps();
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'ls ~/Music' }, ctx: OWNER, deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tier, 'benign');
  assert.strictEqual(calls.verify, 0, 'no PIN on benign');
  assert.strictEqual(calls.execute, 1);
});

// ---- park-and-resume: a destructive action defers, then RUNS on the resume ----

test('destructive action: first pass NEEDS_CEREMONY (does not run), resume on PIN RUNS', async () => {
  const { deps, calls } = makeDeps({ pin: true });
  // First pass — parked, nothing verified or executed.
  const r1 = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm notes.txt' }, ctx: OWNER, deps });
  assert.strictEqual(r1.kind, RESULT.NEEDS_CEREMONY, 'first pass parks, never blocks');
  assert.strictEqual(r1.tier, 'destructive');
  assert.strictEqual(calls.verify, 0, 'no verify before a reply');
  assert.strictEqual(calls.execute, 0, 'does not run before the PIN');
  // Resume — the PIN reply verifies and runs.
  const r2 = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm notes.txt' }, ctx: OWNER, deps, ceremonyReply: '1234' });
  assert.strictEqual(r2.ok, true, 'cleared PIN → allowed (not the old null→deny)');
  assert.strictEqual(r2.tier, 'destructive');
  assert.strictEqual(calls.verify, 1);
  assert.strictEqual(calls.replySeen, '1234', 'the verifier sees the raw reply');
  assert.strictEqual(calls.execute, 1, 'the command actually ran');
  assert.deepStrictEqual(r2.result, { ran: 'run_shell', args: { command: 'rm notes.txt' } });
});

test('no PIN configured (pinConfigured:false) → destructive runs without a ceremony', async () => {
  const { deps, calls } = makeDeps({ pinConfigured: false });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm notes.txt' }, ctx: OWNER, deps });
  assert.strictEqual(r.ok, true, 'owner chose no PIN → the action runs');
  assert.strictEqual(calls.verify, 0, 'nothing to verify');
  assert.strictEqual(calls.execute, 1);
});

test('requiresCeremony but NO verifier wired → fail-closed DENIED, never runs', async () => {
  const { deps } = makeDeps();
  delete deps.verifyPin; // misconfiguration: a destructive action with no way to ceremony
  const calls = { execute: 0 };
  deps.execute = async () => { calls.execute += 1; };
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm x' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.DENIED, 'no verifier → fail closed, not run');
  assert.match(r.reason, /ceremony_declined/);
  assert.strictEqual(calls.execute, 0);
});

test('catastrophic action is a HARD WALL — no PIN, no run, no override', async () => {
  // The owner-decided model (2026-06-19): machine-wreckers never run through the
  // bot. No ceremony can clear them — the owner uses a real terminal.
  const { deps, calls } = makeDeps({ pin: true });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm -rf ~/*' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.DENIED);
  assert.strictEqual(r.reason, 'catastrophic_blocked');
  assert.strictEqual(r.tier, 'catastrophic');
  assert.strictEqual(calls.verify, 0, 'a wall is not a ceremony — no PIN is asked');
  assert.strictEqual(calls.execute, 0, 'it never runs');
});

test('a wrong PIN on the resume → DENIED, execute never runs, reason surfaced', async () => {
  const { deps, calls } = makeDeps({ pin: false });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm x' }, ctx: OWNER, deps, ceremonyReply: '9999' });
  assert.strictEqual(r.kind, RESULT.DENIED);
  assert.strictEqual(r.reason, 'destructive_ceremony_declined');
  assert.match(r.message, /Wrong PIN/, 'the verifier reason is surfaced to the owner');
  assert.strictEqual(calls.execute, 0);
});

test('set_mode(off) is destructive → first pass NEEDS_CEREMONY, resume runs', async () => {
  const { deps, calls } = makeDeps({ pin: true });
  const r1 = await runGovernedAction({ capability: 'set_mode', args: { target: 'Amr', mode: 'off' }, ctx: OWNER, deps });
  assert.strictEqual(r1.kind, RESULT.NEEDS_CEREMONY);
  assert.strictEqual(r1.tier, 'destructive');
  const r2 = await runGovernedAction({ capability: 'set_mode', args: { target: 'Amr', mode: 'off' }, ctx: OWNER, deps, ceremonyReply: '1234' });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(calls.verify, 1);
});

test('the NEEDS_CEREMONY echo is the VERBATIM resolved command, not the intent', async () => {
  const { deps } = makeDeps({ pin: true });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm -rf ./build' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.NEEDS_CEREMONY);
  assert.strictEqual(r.echo, 'rm -rf ./build');
});

test('plain-language intent is recorded on every action', async () => {
  const { deps, calls } = makeDeps();
  await runGovernedAction({ capability: 'set_mode', args: { target: 'Amr', mode: 'silent' }, ctx: OWNER, deps });
  assert.strictEqual(calls.audit.length, 1);
  assert.match(calls.audit[0], /set_mode/);
  assert.match(calls.audit[0], /Amr/);
});

// A denied host attempt must leave a forensic trace. The owner_only floor returns
// BEFORE deps.floor (bareguard), so without this the slash door's denial is recorded
// in neither audit.log nor gate.jsonl — proven live in the M9 LIVE‡ owner-flip run.
test('a non-owner (owner_only) denial is audited as denied-owner', async () => {
  const { deps, calls } = makeDeps();
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'whoami' }, ctx: GUEST, deps });
  assert.strictEqual(r.reason, 'owner_only');
  assert.strictEqual(calls.execute, 0, 'nothing runs');
  assert.strictEqual(calls.audit.length, 1, 'the blocked attempt MUST leave a trace');
  assert.match(calls.audit[0], /run_shell/);
  assert.strictEqual(calls.auditMeta[0].status, 'denied-owner');
});

test('a declined destructive ceremony is audited as denied-ceremony', async () => {
  const { deps, calls } = makeDeps({ pin: false });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm -rf ./build' }, ctx: OWNER, deps, ceremonyReply: '9999' });
  assert.strictEqual(r.kind, RESULT.DENIED);
  assert.match(r.reason, /ceremony_declined/);
  assert.strictEqual(calls.execute, 0, 'declined → nothing runs');
  assert.strictEqual(calls.audit.length, 1, 'the declined attempt MUST leave a trace');
  assert.strictEqual(calls.auditMeta[0].status, 'denied-ceremony');
});

// Audit parity (F5): an Axis-A floor (bareguard) deny on the slash door must ALSO
// land in audit.log — without it the denial showed only in gate.jsonl, breaking
// parity with the denied-owner / denied-ceremony traces above.
test('an Axis-A floor deny is audited as denied-floor', async () => {
  const audit = [];
  const meta = [];
  let ran = 0;
  const deps = {
    denylist: DENYLIST,
    floor: async () => 'Denied: command not permitted',  // bareguard floor denies
    execute: async () => { ran += 1; },
    audit: async (line, m) => { audit.push(line); meta.push(m); },
  };
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'make' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.DENIED);
  assert.strictEqual(r.reason, 'floor');
  assert.strictEqual(ran, 0, 'a floor deny runs nothing');
  assert.strictEqual(audit.length, 1, 'the floor-denied attempt MUST leave a trace');
  assert.match(audit[0], /run_shell/);
  assert.strictEqual(meta[0].status, 'denied-floor');
});
