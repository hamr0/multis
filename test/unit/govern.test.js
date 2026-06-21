'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { runGovernedAction, RESULT } = require('../../src/capabilities/govern');

const DENYLIST = ['rm', 'mv', 'chmod', 'chown', 'kill', 'dd', 'sudo'];

// A test deps factory: records what was called, lets each ceremony pass/fail.
function makeDeps({ pin = true } = {}) {
  const calls = { pin: 0, execute: 0, audit: [], auditMeta: [], echoSeen: null };
  return {
    calls,
    deps: {
      denylist: DENYLIST,
      pinChallenge: async (_ctx, { echo } = {}) => { calls.pin += 1; calls.echoSeen = echo; return pin; },
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
  assert.strictEqual(calls.pin, 0, 'no PIN on benign');
  assert.strictEqual(calls.execute, 1);
});

// ---- THE dead-3-tier fix: a cleared destructive action must actually RUN ----

test('destructive action after a cleared PIN returns ok:true and RUNS', async () => {
  const { deps, calls } = makeDeps({ pin: true });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm notes.txt' }, ctx: OWNER, deps });
  assert.strictEqual(r.ok, true, 'cleared PIN → allowed (not the old null→deny)');
  assert.strictEqual(r.tier, 'destructive');
  assert.strictEqual(calls.pin, 1);
  assert.strictEqual(calls.execute, 1, 'the command actually ran');
  assert.deepStrictEqual(r.result, { ran: 'run_shell', args: { command: 'rm notes.txt' } });
});

test('catastrophic action is a HARD WALL — no PIN, no run, no override', async () => {
  // The owner-decided model (2026-06-19): machine-wreckers never run through the
  // bot. No ceremony can clear them — the owner uses a real terminal.
  const { deps, calls } = makeDeps({ pin: true });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm -rf ~/*' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.DENIED);
  assert.strictEqual(r.reason, 'catastrophic_blocked');
  assert.strictEqual(r.tier, 'catastrophic');
  assert.strictEqual(calls.pin, 0, 'a wall is not a ceremony — no PIN is asked');
  assert.strictEqual(calls.execute, 0, 'it never runs');
});

test('declined PIN on a destructive action → DENIED, execute never runs', async () => {
  const { deps, calls } = makeDeps({ pin: false });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm x' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.DENIED);
  assert.strictEqual(r.reason, 'destructive_ceremony_declined');
  assert.strictEqual(calls.execute, 0);
});

test('set_mode(off) is destructive → ceremonies', async () => {
  const { deps, calls } = makeDeps({ pin: true });
  const r = await runGovernedAction({ capability: 'set_mode', args: { target: 'Amr', mode: 'off' }, ctx: OWNER, deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tier, 'destructive');
  assert.strictEqual(calls.pin, 1);
});

test('the destructive PIN ceremony echoes the VERBATIM resolved command, not the intent', async () => {
  const { deps, calls } = makeDeps({ pin: true });
  await runGovernedAction({ capability: 'run_shell', args: { command: 'rm -rf ./build' }, ctx: OWNER, deps });
  assert.strictEqual(calls.echoSeen, 'rm -rf ./build');
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
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm -rf ./build' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.DENIED);
  assert.match(r.reason, /ceremony_declined/);
  assert.strictEqual(calls.execute, 0, 'declined → nothing runs');
  assert.strictEqual(calls.audit.length, 1, 'the declined attempt MUST leave a trace');
  assert.strictEqual(calls.auditMeta[0].status, 'denied-ceremony');
});
