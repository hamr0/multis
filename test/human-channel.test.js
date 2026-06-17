const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const { createHumanPrompt } = require('../src/governance/human-channel');
const { PendingRegistry } = require('../src/bot/pending');

function mockPlatform() {
  const sent = [];
  return { send: async (chatId, text) => { sent.push({ chatId, text }); }, sent };
}

function askEvent(reqCtx) {
  return { rule: 'confirm-exec', reason: 'about to run', action: { type: 'bash', command: 'ls', _ctx: reqCtx } };
}

async function tick() { await new Promise(r => setTimeout(r, 10)); }

// Deliver a reply the way the router's gate_reply dispatch does: resolve the
// parked registry entry for that (chat, sender). Returns false when nothing is
// parked there — which is exactly how a non-owner reply gets ignored.
function deliver(pending, chatId, senderId, text) {
  const e = pending.get(chatId, senderId);
  if (!e) return false;
  e.resolve(text);
  return true;
}

describe('createHumanPrompt — approvals route to the owner (#7)', () => {
  let pending;
  beforeEach(() => { pending = new PendingRegistry(); });

  it('routes the prompt to the Telegram owner, not the requesting customer', async () => {
    const tele = mockPlatform();
    const beeper = mockPlatform();
    const registry = new Map([['telegram', tele], ['beeper', beeper]]);
    const humanPrompt = createHumanPrompt({ platformRegistry: registry, config: { owner_id: 'owner1' }, pending, timeoutMs: 1000 });

    // The request originates from an untrusted customer chat on Beeper.
    const p = humanPrompt(askEvent({ senderId: 'cust', chatId: 'cust_chat', platform: 'beeper' }));
    await tick();
    // Only the OWNER can approve — a reply from the customer must do nothing:
    // the waiter is parked under the owner's (chat, sender), not the customer's.
    assert.strictEqual(deliver(pending, 'cust_chat', 'cust', 'yes'), false, 'customer cannot self-approve');
    assert.ok(deliver(pending, 'owner1', 'owner1', 'yes'), 'owner reply is consumed');

    assert.deepStrictEqual(await p, { decision: 'allow' });
    assert.strictEqual(tele.sent.at(-1).chatId, 'owner1', 'prompt went to the owner');
    assert.strictEqual(beeper.sent.length, 0, 'nothing sent to the customer chat');
  });

  it('falls back to the requester when there is no deterministic owner channel', async () => {
    const beeper = mockPlatform();
    const registry = new Map([['beeper', beeper]]); // no Telegram → no owner route
    const humanPrompt = createHumanPrompt({ platformRegistry: registry, config: { owner_id: 'owner1' }, pending, timeoutMs: 1000 });

    // On Beeper-only the requester (note-to-self) IS the owner.
    const p = humanPrompt(askEvent({ senderId: 'self', chatId: 'self_chat', platform: 'beeper' }));
    await tick();
    deliver(pending, 'self_chat', 'self', 'no');
    assert.deepStrictEqual(await p, { decision: 'deny' });
    assert.strictEqual(beeper.sent.at(-1).chatId, 'self_chat');
  });
});
