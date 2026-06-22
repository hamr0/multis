const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const { createPinChallenge } = require('../src/governance/human-channel');
const { PendingRegistry } = require('../src/bot/pending');

function mockPlatform() {
  const sent = [];
  return { send: async (chatId, text) => { sent.push({ chatId, text }); }, sent };
}

// Fresh shared registry per test (the challenge parks its waiter here; the
// router would normally deliver the reply by resolving the entry).
let pending;

// A pinManager stub — only the three methods createPinChallenge touches.
function stubPin({ enabled = true, auth = true, correct = '1234' } = {}) {
  return {
    isEnabled: () => enabled,
    needsAuth: () => auth,
    authenticate: (_id, pin) =>
      pin === correct ? { success: true } : { success: false, reason: 'Wrong PIN. 2 attempts remaining.' },
  };
}

// Deliver a reply once the challenge has registered its waiter — exactly what
// the router's gate_reply dispatch does: resolve the parked registry entry.
async function deliverReply(chatId, senderId, text) {
  await new Promise(r => setTimeout(r, 10));
  const e = pending.get(chatId, senderId);
  if (!e) return false;
  e.resolve(text);
  return true;
}

describe('createPinChallenge (#5)', () => {
  beforeEach(() => { pending = new PendingRegistry(); });

  it('no-ops (allows) when PIN is not configured', async () => {
    const plat = mockPlatform();
    const challenge = createPinChallenge({ pending, platformRegistry: new Map([['telegram', plat]]), pinManager: stubPin({ enabled: false }) });
    assert.strictEqual(await challenge({ senderId: 'u', chatId: 'c', platform: 'telegram' }), true);
    assert.strictEqual(plat.sent.length, 0, 'must not prompt when PIN unset');
  });

  it('STILL prompts even when the session is fresh — destructive always re-ceremonies (M9 always-ceremony)', async () => {
    // A fresh PIN session must NOT bypass a destructive ceremony (owner-decided
    // 2026-06-20): the 24h session shortcut undercut "no destructive capability
    // bypasses ceremony". With auth:false (fresh session) the challenge must still
    // prompt and verify — proven by the waiter actually being parked + consumed.
    const plat = mockPlatform();
    const challenge = createPinChallenge({ pending, platformRegistry: new Map([['telegram', plat]]), pinManager: stubPin({ auth: false }), timeoutMs: 1000 });
    const p = challenge({ senderId: 'u', chatId: 'c', platform: 'telegram' });
    assert.ok(await deliverReply('c', 'u', '1234'), 'a fresh session must NOT skip the prompt — the waiter is parked');
    assert.strictEqual(await p, true);
    assert.match(plat.sent[0].text, /needs your PIN/i);
  });

  it('prompts, accepts the correct PIN, resolves true', async () => {
    const plat = mockPlatform();
    const challenge = createPinChallenge({ pending, platformRegistry: new Map([['telegram', plat]]), pinManager: stubPin(), timeoutMs: 1000 });
    const p = challenge({ senderId: 'u', chatId: 'c', platform: 'telegram' });
    assert.ok(await deliverReply('c', 'u', '1234'), 'reply was consumed by the waiter');
    assert.strictEqual(await p, true);
    assert.match(plat.sent[0].text, /needs your PIN/i);
    assert.match(plat.sent.at(-1).text, /accepted/i);
  });

  it('rejects a wrong PIN, resolves false', async () => {
    const plat = mockPlatform();
    const challenge = createPinChallenge({ pending, platformRegistry: new Map([['telegram', plat]]), pinManager: stubPin(), timeoutMs: 1000 });
    const p = challenge({ senderId: 'u', chatId: 'c', platform: 'telegram' });
    await deliverReply('c', 'u', '0000');
    assert.strictEqual(await p, false);
    assert.match(plat.sent.at(-1).text, /Wrong PIN/);
  });

  it('times out to false when no reply arrives', async () => {
    const plat = mockPlatform();
    const challenge = createPinChallenge({ pending, platformRegistry: new Map([['telegram', plat]]), pinManager: stubPin(), timeoutMs: 25 });
    // The waiter's timer is unref'd (so it never blocks bot shutdown); in an
    // isolated test nothing else keeps the loop alive, so hold a ref'd guard.
    const guard = setInterval(() => {}, 1000);
    try {
      assert.strictEqual(await challenge({ senderId: 'u', chatId: 'c', platform: 'telegram' }), false);
      assert.match(plat.sent.at(-1).text, /timed out/i);
    } finally {
      clearInterval(guard);
    }
  });

  it('fails closed (false) when the owner channel is unreachable', async () => {
    const challenge = createPinChallenge({ pending, platformRegistry: new Map(), pinManager: stubPin() });
    assert.strictEqual(await challenge({ senderId: 'u', chatId: 'c', platform: 'telegram' }), false);
  });

  it('parks with a registry TTL looser than its timeout (timer governs, not announce-on-expiry)', async () => {
    const plat = mockPlatform();
    const challenge = createPinChallenge({ pending, platformRegistry: new Map([['telegram', plat]]), pinManager: stubPin(), timeoutMs: 1000 });
    const p = challenge({ senderId: 'u', chatId: 'c', platform: 'telegram' });
    await new Promise((r) => setTimeout(r, 10)); // let the waiter park

    const e = pending.peek('c', 'u');
    assert.strictEqual(e.kind, 'gate_reply');
    assert.ok(e.ttlMs > 1000, 'registry TTL is a loose backstop past the timer, so a gate reply is never announced-as-expired');

    e.resolve('1234'); // clean up the parked waiter
    await p;
  });

  it('denies on lockout without waiting for input', async () => {
    const plat = mockPlatform();
    const challenge = createPinChallenge({ pending, platformRegistry: new Map([['telegram', plat]]), pinManager: stubPin({ auth: 'locked' }) });
    assert.strictEqual(await challenge({ senderId: 'u', chatId: 'c', platform: 'telegram' }), false);
    assert.match(plat.sent.at(-1).text, /Locked out/i);
  });
});
