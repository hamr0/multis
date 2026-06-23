'use strict';

/**
 * REGRESSION (found live 2026-06-22): a destructive governed action on Beeper
 * deadlocks the poll loop.
 *
 * Beeper's `_poll()` is SERIAL with an overlap guard: it sets `_polling = true`
 * and drains each message with `await this._handleMessage(msg)`; the 3s interval
 * is a no-op while a handler is in flight (beeper.js). The original M9 ceremony was
 * inline-blocking (`await pinChallenge → waitForReply`), which parked a waiter and
 * resolved only when the NEXT message was polled. On Beeper the next message (the
 * owner's PIN) could never be fetched while the handler blocked → the action froze
 * for the full PIN timeout, the typed PIN ignored, every chat stalled. (Telegram
 * survived because Telegraf dispatches each update concurrently, so the PIN reply
 * ran in its own context.)
 *
 * The fix (Option C, park-and-resume): `runGovernedAction` returns
 * RESULT.NEEDS_CEREMONY instead of blocking; the caller parks the ACTION and
 * returns immediately (freeing the poll loop); when the PIN arrives on the next
 * poll, the action is resumed via `runGovernedAction({..., ceremonyReply})`.
 *
 * This test reproduces the exact production topology — a faithful serial poll loop
 * driving the REAL runGovernedAction + REAL PendingRegistry, PIN queued as the next
 * message — and guards the fix: it would deadlock (action never executes) under the
 * old inline ceremony, and passes with park-and-resume.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runGovernedAction, RESULT } = require('../../src/capabilities/govern');
const { SEVERITY } = require('../../src/capabilities/registry');
const { PendingRegistry } = require('../../src/bot/pending');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A destructive capability — requires the PIN ceremony (classifyEffectiveSeverity
// returns DESTRUCTIVE → requiresCeremony true).
const CAP = { name: 'demo_destroy', ownerOnly: false, args: null, severity: SEVERITY.DESTRUCTIVE };

/**
 * A faithful copy of the Beeper poll model: serial drain + overlap guard. While a
 * handler awaits, the interval tick is a no-op, so nothing else is fetched.
 */
function makeSerialPoller(handle) {
  const queue = [];
  let polling = false;
  let timer = null;
  async function pollOnce() {
    if (polling) return;            // overlap guard (beeper.js:112)
    polling = true;
    try {
      while (queue.length) {
        const msg = queue.shift();
        await handle(msg);          // SERIAL await (beeper.js:127) — the deadlock surface
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

describe('Beeper serial poll loop + destructive ceremony', () => {
  it('a destructive action followed by the PIN reply EXECUTES (no deadlock)', async () => {
    const pending = new PendingRegistry();

    let executed = false;
    const ctx = { senderId: 'owner', chatId: 'amora', platform: 'beeper', isOwner: true };

    const deps = {
      // Park-and-resume: the core never blocks awaiting a reply; it returns
      // NEEDS_CEREMONY and verifies the parked PIN here when it arrives.
      verifyPin: (_ctx, reply) => ({ ok: String(reply).trim() === '1234' }),
      execute: async () => { executed = true; return 'destroyed'; },
    };

    // The caller (mirrors what handlers.js will do): park the action on
    // NEEDS_CEREMONY, resume it when the PIN arrives.
    async function handle(msg) {
      const entry = pending.get(msg.chatId, msg.senderId);
      if (entry && entry.kind === 'ceremony_action') {
        pending.clear(msg.chatId, msg.senderId);
        await runGovernedAction({
          capability: entry.capability, args: entry.args, ctx: entry.ctx,
          deps, ceremonyReply: msg.text,
        });
        return;
      }
      const r = await runGovernedAction({ capability: CAP, args: {}, ctx, deps });
      if (r && r.kind === RESULT.NEEDS_CEREMONY) {
        pending.set(msg.chatId, msg.senderId, 'ceremony_action', {
          capability: r.capability, args: r.args, ctx: r.ctx, ttlMs: 5000,
        });
      }
    }

    const poller = makeSerialPoller(handle);
    poller.start();
    poller.enqueue({ chatId: 'amora', senderId: 'owner', text: '<destroy>' });
    poller.enqueue({ chatId: 'amora', senderId: 'owner', text: '1234' });

    // Generous window: park-and-resume finishes in ~one drain (<50ms). The
    // deadlocked path can't finish at all (it times out and never executes).
    await delay(500);
    poller.stop();

    assert.strictEqual(
      executed, true,
      'destructive action must execute after the PIN reply — a serial poll loop must not deadlock the ceremony',
    );
  });
});
