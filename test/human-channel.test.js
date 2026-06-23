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

describe('createHumanPrompt — Beeper asks fail closed (serial-poll, no inline HITL)', () => {
  let pending;
  beforeEach(() => { pending = new PendingRegistry(); });

  it('a Beeper-triggered ask is auto-declined and the owner is notified, not the customer (#7)', async () => {
    const tele = mockPlatform();
    const beeper = mockPlatform();
    const registry = new Map([['telegram', tele], ['beeper', beeper]]);
    const humanPrompt = createHumanPrompt({ platformRegistry: registry, config: { owner_id: 'owner1' }, pending, timeoutMs: 1000 });

    // A customer on Beeper triggers an ask. Beeper's serial poll can't run an
    // inline yes/no (it would freeze), so the ask fails closed: the customer
    // cannot self-approve (nothing is parked), and the owner is notified rather
    // than the loop frozen. (Risky actions now escalate to the PIN ceremony.)
    const r = await humanPrompt(askEvent({ senderId: 'cust', chatId: 'cust_chat', platform: 'beeper' }));
    assert.strictEqual(r.decision, 'deny', 'beeper-triggered ask is auto-denied');
    assert.strictEqual(deliver(pending, 'cust_chat', 'cust', 'yes'), false, 'nothing parked — customer cannot self-approve');
    assert.strictEqual(tele.sent.at(-1).chatId, 'owner1', 'owner notified (routed to the owner, not the requester)');
    assert.strictEqual(beeper.sent.length, 0, 'customer chat untouched');
  });

  it('a Beeper-only ask still fails closed (requester is the owner; no inline HITL on serial poll)', async () => {
    const beeper = mockPlatform();
    const registry = new Map([['beeper', beeper]]); // no Telegram → requester IS the owner
    const humanPrompt = createHumanPrompt({ platformRegistry: registry, config: { owner_id: 'owner1' }, pending, timeoutMs: 1000 });

    const r = await humanPrompt(askEvent({ senderId: 'self', chatId: 'self_chat', platform: 'beeper' }));
    assert.strictEqual(r.decision, 'deny', 'beeper ask fails closed even for the owner');
    assert.strictEqual(beeper.sent.at(-1).chatId, 'self_chat', 'owner notified on their own chat');
  });
});
