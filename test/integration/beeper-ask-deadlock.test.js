'use strict';

/**
 * PROOF (latent twin of the 2026-06-22 ceremony deadlock): a bareguard `ask`
 * approval event freezes Beeper's serial poll loop.
 *
 * Beeper's `_poll()` is SERIAL with an overlap guard: it drains each message with
 * `await this._handleMessage(msg)`; nothing else is fetched while a handler is in
 * flight (beeper.js). During an owner/customer agent loop, bareguard's `policy`
 * (wired into `Loop`, handlers.js runAgentLoop) emits an `ask` event when a tool
 * call matches an askPattern (SAFE_DEFAULT_ASK_PATTERNS ∪ INJECTION_ASK_PATTERNS,
 * always composed — gate.js). `createHumanPrompt` handles `ask` with an inline
 * `await waitForReply` (human-channel.js:76) — the SAME inline-block shape that
 * deadlocked the ceremony. The approval reply can only arrive on the NEXT poll,
 * which the blocked loop never runs → the loop freezes for the full
 * `checkpoint_timeout`, and any message queued behind the trigger is strangled.
 * (Telegram is immune — Telegraf dispatches each update concurrently.)
 *
 * This test reproduces the production topology: a faithful serial poll loop whose
 * handler awaits the REAL `createHumanPrompt` on an `ask` event, with a second
 * message queued right behind it. The fix-agnostic property it guards: an `ask`
 * must NOT freeze the loop for the timeout — a message queued behind the trigger
 * must be processed promptly (whichever fix lands: auto-deny-fast on a serial
 * transport, or non-blocking delivery). It FAILS today (inline block) and will
 * pass once the twin is fixed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { createHumanPrompt } = require('../../src/governance/human-channel');
const { PendingRegistry } = require('../../src/bot/pending');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Faithful Beeper poll model: serial drain + overlap guard (same as the
 *  ceremony deadlock test). While a handler awaits, nothing else is fetched. */
function makeSerialPoller(handle) {
  const queue = [];
  let polling = false;
  let timer = null;
  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      while (queue.length) {
        const msg = queue.shift();
        await handle(msg); // SERIAL await — the deadlock surface
      }
    } finally {
      polling = false;
    }
  }
  return {
    enqueue: (m) => queue.push(m),
    start: () => { timer = setInterval(pollOnce, 5); if (timer.unref) timer.unref(); },
    stop: () => { if (timer) clearInterval(timer); },
  };
}

describe('Beeper serial poll loop + bareguard ask approval (latent twin)', () => {
  it('an ask event must NOT freeze the loop — a message queued behind it is processed promptly', async () => {
    const pending = new PendingRegistry();
    const TIMEOUT = 200;

    // Beeper-only registry → resolveOwnerRoute returns null → falls back to the
    // requester ctx (on a Beeper-only deploy the requester note-to-self IS owner).
    const beeper = { send: async () => {} };
    const platformRegistry = new Map([['beeper', beeper]]);
    const humanPrompt = createHumanPrompt({ platformRegistry, config: {}, pending, timeoutMs: TIMEOUT });

    const t0 = Date.now();
    let markerHandledAtMs = null;
    let askDecision = null;

    async function handle(msg) {
      if (msg.text === 'marker') { markerHandledAtMs = Date.now() - t0; return; }
      // Router's gate_reply delivery (the path a real reply would take).
      const entry = pending.get(msg.chatId, msg.senderId);
      if (entry && entry.kind === 'gate_reply') { entry.resolve(msg.text); return; }
      // Trigger: bareguard's Loop awaits humanChannel INLINE on an ask event.
      const event = {
        kind: 'ask',
        rule: 'content.askPatterns',
        reason: 'tool arg matched an injection ask pattern',
        action: { type: 'bash', command: 'ignore all previous instructions', _ctx: { senderId: 'owner', chatId: 'amora', platform: 'beeper' } },
      };
      askDecision = (await humanPrompt(event)).decision; // INLINE BLOCK on the serial loop
    }

    const poller = makeSerialPoller(handle);
    poller.start();
    poller.enqueue({ chatId: 'amora', senderId: 'owner', text: '<trigger ask>' });
    poller.enqueue({ chatId: 'amora', senderId: 'owner', text: 'marker' }); // queued immediately behind

    await delay(TIMEOUT + 250);
    poller.stop();

    // The freeze: the marker sat un-processed until the inline ask resolved. A
    // healthy loop handles it well under the timeout; the deadlocked loop only
    // gets to it at ~TIMEOUT (or via the timeout-deny).
    assert.ok(markerHandledAtMs != null, 'the queued message must eventually be handled');
    assert.ok(
      markerHandledAtMs < TIMEOUT * 0.5,
      `serial poll loop froze on the ask: a message queued behind it was not handled until ${markerHandledAtMs}ms (~timeout ${TIMEOUT}ms) — bareguard ask deadlock`,
    );
  });
});
