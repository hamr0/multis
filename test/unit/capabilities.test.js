'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  SEVERITY,
  CAPABILITIES,
  getCapability,
  listCapabilities,
  classifyEffectiveSeverity,
  requiresCeremony,
} = require('../../src/capabilities/registry');

// A representative governance denylist (the real one lives in governance.json).
const DENYLIST = ['rm', 'mv', 'chmod', 'chown', 'kill', 'dd', 'sudo'];

test('every capability declares scope + severity + a valid args shape', () => {
  for (const cap of CAPABILITIES) {
    assert.ok(cap.name, 'capability has a name');
    assert.ok(['host', 'app'].includes(cap.kind), `${cap.name} has a kind`);
    assert.ok(typeof cap.scope === 'string' && cap.scope.length, `${cap.name} declares scope`);
    assert.ok(cap.severity, `${cap.name} declares severity`);
    // args is either null (no args) or a JSON-schema object with properties
    if (cap.args !== null) {
      assert.strictEqual(cap.args.type, 'object', `${cap.name} args is an object schema`);
      assert.ok(cap.args.properties, `${cap.name} args has properties`);
    }
    assert.strictEqual(typeof cap.ownerOnly, 'boolean', `${cap.name} declares ownerOnly`);
  }
});

test('raw exec/read are NOT app-verbs (M9 removes the raw-shell front door)', () => {
  const appNames = CAPABILITIES.filter((c) => c.kind === 'app').map((c) => c.name);
  assert.ok(!appNames.includes('exec'), 'no /exec app-verb');
  assert.ok(!appNames.includes('read'), 'no /read app-verb');
  // host shell is reachable only as the governed run_shell capability
  assert.ok(getCapability('run_shell'), 'run_shell host capability exists');
  assert.strictEqual(getCapability('run_shell').kind, 'host');
});

test('run_shell wraps the existing exec tool and keeps its execute', () => {
  const cap = getCapability('run_shell');
  assert.ok(cap.tool, 'carries the source tool definition');
  assert.strictEqual(typeof cap.tool.execute, 'function', 'execute is reused, not rewritten');
  assert.ok(cap.args.properties.command, 'inherits the exec input_schema');
});

test('owner-only floor is preserved from the existing registry', () => {
  assert.strictEqual(getCapability('run_shell').ownerOnly, true);
  assert.strictEqual(getCapability('read_file').ownerOnly, true);
  assert.strictEqual(getCapability('find_files').ownerOnly, true);
  assert.strictEqual(getCapability('index').ownerOnly, true);
  assert.strictEqual(getCapability('status').ownerOnly, false);
  assert.strictEqual(getCapability('help').ownerOnly, false);
});

test('aliases resolve to the canonical capability', () => {
  for (const alias of ['mode', 'silent', 'business', 'personal', 'off']) {
    assert.strictEqual(getCapability(alias)?.name, 'set_mode', `${alias} → set_mode`);
  }
});

test('listCapabilities hides owner-only verbs from a non-owner', () => {
  const ownerView = listCapabilities({ platform: 'linux', isOwner: true }).map((c) => c.name);
  const guestView = listCapabilities({ platform: 'linux', isOwner: false }).map((c) => c.name);
  assert.ok(ownerView.includes('run_shell'), 'owner sees run_shell');
  assert.ok(!guestView.includes('run_shell'), 'non-owner never sees run_shell');
  assert.ok(!guestView.includes('index'), 'non-owner never sees /index');
  assert.ok(guestView.includes('help'), 'non-owner still sees /help');
});

// ---- the load-bearing invariant from the 2026-06-19 negative POC ----

test('shell severity is resolved per-command (3-tier)', () => {
  const sh = getCapability('run_shell');
  assert.strictEqual(classifyEffectiveSeverity(sh, { command: 'ls ~/Music' }, DENYLIST), SEVERITY.BENIGN);
  assert.strictEqual(classifyEffectiveSeverity(sh, { command: 'rm notes.txt' }, DENYLIST), SEVERITY.DESTRUCTIVE);
  assert.strictEqual(classifyEffectiveSeverity(sh, { command: 'rm -rf ~/*' }, DENYLIST), SEVERITY.CATASTROPHIC);
});

test('set_mode(off) escalates to destructive; other modes stay benign', () => {
  const m = getCapability('set_mode');
  assert.strictEqual(classifyEffectiveSeverity(m, { target: 'Amr', mode: 'silent' }), SEVERITY.BENIGN);
  assert.strictEqual(classifyEffectiveSeverity(m, { target: 'Amr', mode: 'off' }), SEVERITY.DESTRUCTIVE);
});

test('INVARIANT: a destructive/catastrophic effective tier ALWAYS requires ceremony', () => {
  // the hijacked rm -rf from the negative POC: even fully model-driven, it ceremonies.
  const sh = getCapability('run_shell');
  assert.ok(requiresCeremony(classifyEffectiveSeverity(sh, { command: 'rm -rf ~/*' }, DENYLIST)));
  assert.ok(requiresCeremony(classifyEffectiveSeverity(sh, { command: 'rm x' }, DENYLIST)));
  assert.ok(requiresCeremony(classifyEffectiveSeverity(getCapability('set_mode'), { mode: 'off' })));
  assert.ok(requiresCeremony(classifyEffectiveSeverity(getCapability('forget'), { target: 'x' })));
  // and a benign action does NOT (no false ceremony on every action)
  assert.ok(!requiresCeremony(classifyEffectiveSeverity(getCapability('status'), {})));
  assert.ok(!requiresCeremony(classifyEffectiveSeverity(sh, { command: 'cat readme' }, DENYLIST)));
});

test('INVARIANT: no statically-destructive capability ever classifies benign', () => {
  for (const cap of CAPABILITIES) {
    if (cap.severity === SEVERITY.DESTRUCTIVE || cap.severity === SEVERITY.CATASTROPHIC) {
      const tier = classifyEffectiveSeverity(cap, {}, DENYLIST);
      assert.ok(requiresCeremony(tier), `${cap.name} (declared ${cap.severity}) must require ceremony`);
    }
  }
});
