'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// F4 (security audit 2026-07-07): a PIN is MANDATORY at init. With no PIN
// configured, the destructive-command ceremony degrades to a no-op (commands run
// unprompted), so `multis init` must not let the owner skip it. readPin loops
// until a valid 4-6 digit PIN is entered; there is no skip. `ask`/`warn` are
// injected so the loop is exercised without a real TTY.
const { readPin } = require('../../bin/multis.js');

// A scripted `ask` that returns each queued answer in turn.
function scriptedAsk(answers) {
  let i = 0;
  return async () => (i < answers.length ? answers[i++] : '');
}

test('F4: readPin (mandatory) re-prompts past empty + malformed entries until a valid PIN', async () => {
  const warns = [];
  const ask = scriptedAsk(['', 'abc', '12', '1234567', '1234']);
  const pin = await readPin(ask, { allowKeep: false, warn: (m) => warns.push(m) });
  assert.strictEqual(pin, '1234', 'returns the first valid 4-6 digit PIN');
  assert.strictEqual(warns.length, 4, 'each of the 4 invalid entries warned and re-prompted (no skip)');
});

test('F4: mandatory readPin never returns null (empty is not an accepted skip)', async () => {
  const ask = scriptedAsk(['', '', '', '9999']);
  const pin = await readPin(ask, { allowKeep: false, warn: () => {} });
  assert.strictEqual(pin, '9999');
  assert.notStrictEqual(pin, null);
});

test('F4: allowKeep lets an existing PIN be retained on an empty line (returns null)', async () => {
  const ask = scriptedAsk(['']);
  const pin = await readPin(ask, { allowKeep: true, warn: () => {} });
  assert.strictEqual(pin, null, 'empty line with allowKeep = keep existing');
});

test('F4: allowKeep still validates a newly-typed PIN (junk re-prompts, valid returns)', async () => {
  const warns = [];
  const ask = scriptedAsk(['nope', '55555']);
  const pin = await readPin(ask, { allowKeep: true, warn: (m) => warns.push(m) });
  assert.strictEqual(pin, '55555');
  assert.strictEqual(warns.length, 1);
});

test('F4: accepts 4, 5, and 6 digit PINs; rejects 3 and 7 digits', async () => {
  for (const good of ['1234', '12345', '123456']) {
    assert.strictEqual(await readPin(scriptedAsk([good]), { warn: () => {} }), good);
  }
  // 3-digit then a valid one → the 3-digit is rejected (re-prompt), valid returned.
  const warns = [];
  const pin = await readPin(scriptedAsk(['123', '4321']), { warn: (m) => warns.push(m) });
  assert.strictEqual(pin, '4321');
  assert.strictEqual(warns.length, 1, 'the 3-digit entry was rejected');
});
