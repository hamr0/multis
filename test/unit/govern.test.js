'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { runGovernedAction, RESULT } = require('../../src/capabilities/govern');

const DENYLIST = ['rm', 'mv', 'chmod', 'chown', 'kill', 'dd', 'sudo'];

// A test deps factory: records what was called, lets each ceremony pass/fail.
function makeDeps({ pin = true, confirm = true } = {}) {
  const calls = { pin: 0, confirm: 0, execute: 0, audit: [], echoSeen: null };
  return {
    calls,
    deps: {
      denylist: DENYLIST,
      pinChallenge: async (_ctx, { echo } = {}) => { calls.pin += 1; calls.echoSeen = echo; return pin; },
      confirmChallenge: async (_ctx, echo) => { calls.confirm += 1; calls.echoSeen = echo; return confirm; },
      execute: async (cap, args) => { calls.execute += 1; return { ran: cap.name, args }; },
      audit: async (line) => { calls.audit.push(line); },
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
  assert.strictEqual(calls.confirm, 0, 'destructive needs no CONFIRM');
  assert.strictEqual(calls.execute, 1, 'the command actually ran');
  assert.deepStrictEqual(r.result, { ran: 'run_shell', args: { command: 'rm notes.txt' } });
});

test('catastrophic action requires PIN + CONFIRM, then runs', async () => {
  const { deps, calls } = makeDeps({ pin: true, confirm: true });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm -rf ~/*' }, ctx: OWNER, deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tier, 'catastrophic');
  assert.strictEqual(calls.pin, 1);
  assert.strictEqual(calls.confirm, 1);
  assert.strictEqual(calls.execute, 1);
});

test('declined PIN → DENIED, execute never runs', async () => {
  const { deps, calls } = makeDeps({ pin: false });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm x' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.DENIED);
  assert.strictEqual(r.reason, 'destructive_ceremony_declined');
  assert.strictEqual(calls.execute, 0);
});

test('declined CONFIRM on a catastrophic action → DENIED', async () => {
  const { deps, calls } = makeDeps({ pin: true, confirm: false });
  const r = await runGovernedAction({ capability: 'run_shell', args: { command: 'rm -rf ~/*' }, ctx: OWNER, deps });
  assert.strictEqual(r.kind, RESULT.DENIED);
  assert.strictEqual(calls.confirm, 1);
  assert.strictEqual(calls.execute, 0);
});

test('set_mode(off) is destructive → ceremonies', async () => {
  const { deps, calls } = makeDeps({ pin: true });
  const r = await runGovernedAction({ capability: 'set_mode', args: { target: 'Amr', mode: 'off' }, ctx: OWNER, deps });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tier, 'destructive');
  assert.strictEqual(calls.pin, 1);
});

test('the ceremony echoes the VERBATIM resolved command, not the intent', async () => {
  const { deps, calls } = makeDeps({ pin: true, confirm: true });
  await runGovernedAction({ capability: 'run_shell', args: { command: 'rm -rf ~/Downloads/*' }, ctx: OWNER, deps });
  assert.strictEqual(calls.echoSeen, 'rm -rf ~/Downloads/*');
});

test('plain-language intent is recorded on every action', async () => {
  const { deps, calls } = makeDeps();
  await runGovernedAction({ capability: 'set_mode', args: { target: 'Amr', mode: 'silent' }, ctx: OWNER, deps });
  assert.strictEqual(calls.audit.length, 1);
  assert.match(calls.audit[0], /set_mode/);
  assert.match(calls.audit[0], /Amr/);
});
