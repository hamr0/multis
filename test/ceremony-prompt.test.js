'use strict';

/**
 * Park-and-resume ceremony builders (replaces the old inline createPinChallenge,
 * retired 2026-06-22 — it deadlocked a serial Beeper poll loop). The ceremony is
 * now split into two non-blocking halves:
 *   createCeremonyPrompt — sends the PIN prompt (or the lockout line), returns a status.
 *   createVerifyPin      — verifies the reply the core hands back. No awaiting a reply.
 * Same security properties as before (lockout, wrong PIN, no-PIN-configured), proven here.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { createCeremonyPrompt, createVerifyPin } = require('../src/governance/human-channel');

function mockPlatform() {
  const sent = [];
  return { send: async (chatId, text) => { sent.push({ chatId, text }); }, sent };
}

// pinManager stub — only the methods the builders touch.
function stubPin({ enabled = true, auth = true, correct = '1234' } = {}) {
  return {
    isEnabled: () => enabled,
    needsAuth: () => auth, // true | false | 'locked'
    authenticate: (_id, pin) =>
      pin === correct ? { success: true } : { success: false, reason: 'Wrong PIN. 2 attempts remaining.' },
  };
}

const CTX = { senderId: 'u', chatId: 'c', platform: 'telegram' };

describe('createVerifyPin', () => {
  it('no PIN configured → { ok: true } (parity with "no PIN → allow")', async () => {
    const verify = createVerifyPin({ pinManager: stubPin({ enabled: false }) });
    assert.deepStrictEqual(await verify(CTX, 'anything'), { ok: true });
  });

  it('correct PIN → { ok: true }', async () => {
    const verify = createVerifyPin({ pinManager: stubPin() });
    assert.deepStrictEqual(await verify(CTX, '1234'), { ok: true });
  });

  it('wrong PIN → { ok: false } with the reason surfaced', async () => {
    const verify = createVerifyPin({ pinManager: stubPin() });
    const r = await verify(CTX, '9999');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /Wrong PIN/);
  });

  it('trims whitespace around the reply before verifying', async () => {
    const verify = createVerifyPin({ pinManager: stubPin() });
    assert.deepStrictEqual(await verify(CTX, '  1234 \n'), { ok: true });
  });
});

describe('createCeremonyPrompt', () => {
  it('prompts with the verbatim echo and returns "prompted"', async () => {
    const plat = mockPlatform();
    const prompt = createCeremonyPrompt({ platformRegistry: new Map([['telegram', plat]]), pinManager: stubPin() });
    const status = await prompt(CTX, { echo: 'rm -rf ./build' });
    assert.strictEqual(status, 'prompted');
    assert.match(plat.sent[0].text, /needs your PIN/i);
    assert.match(plat.sent[0].text, /rm -rf \.\/build/, 'echoes the resolved action');
  });

  it('lockout → sends the lockout line and returns "locked" (no prompt)', async () => {
    const plat = mockPlatform();
    const prompt = createCeremonyPrompt({ platformRegistry: new Map([['telegram', plat]]), pinManager: stubPin({ auth: 'locked' }) });
    const status = await prompt(CTX, { echo: 'x' });
    assert.strictEqual(status, 'locked');
    assert.match(plat.sent[0].text, /Locked out/i);
    assert.ok(!plat.sent.some((s) => /needs your PIN/i.test(s.text)), 'does not prompt while locked');
  });

  it('no reachable channel → "no-channel", fails closed (nothing parked)', async () => {
    const prompt = createCeremonyPrompt({ platformRegistry: new Map(), pinManager: stubPin() });
    assert.strictEqual(await prompt(CTX, { echo: 'x' }), 'no-channel');
  });
});
