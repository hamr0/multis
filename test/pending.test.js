'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PendingRegistry, DEFAULT_TTL_MS } = require('../src/bot/pending');

// A controllable clock so TTL behaviour is deterministic (no real sleeps).
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('PendingRegistry', () => {
  it('stores and retrieves an entry by the chatId:senderId tuple', () => {
    const reg = new PendingRegistry();
    reg.set('chatA', 'userA', 'pin_command', { data: { command: 'exec' } });
    const e = reg.get('chatA', 'userA');
    assert.strictEqual(e.kind, 'pin_command');
    assert.strictEqual(e.data.command, 'exec');
  });

  it('isolates entries that share a senderId across different chats', () => {
    // The whole reason for the tuple key: same user, two chats, no collision.
    const reg = new PendingRegistry();
    reg.set('chatA', 'userA', 'mode', { data: 1 });
    reg.set('chatB', 'userA', 'index', { data: 2 });
    assert.strictEqual(reg.get('chatA', 'userA').kind, 'mode');
    assert.strictEqual(reg.get('chatB', 'userA').kind, 'index');
    assert.strictEqual(reg.size, 2);
  });

  it('clear() removes the entry', () => {
    const reg = new PendingRegistry();
    reg.set('c', 'u', 'pin_command', {});
    reg.clear('c', 'u');
    assert.strictEqual(reg.get('c', 'u'), null);
  });

  it('returns null when nothing is pending', () => {
    const reg = new PendingRegistry();
    assert.strictEqual(reg.get('c', 'u'), null);
  });

  it('is payload-agnostic — carries a resolve fn (parked-promise flavour) as opaquely as data', () => {
    const reg = new PendingRegistry();
    let resolved = null;
    reg.set('c', 'u', 'gate_pin', { resolve: (v) => { resolved = v; } });
    reg.get('c', 'u').resolve('ok');
    assert.strictEqual(resolved, 'ok');
  });

  describe('TTL expiry', () => {
    it('keeps an entry live up to its TTL', () => {
      const clk = fakeClock();
      const reg = new PendingRegistry({ now: clk.now });
      reg.set('c', 'u', 'pin_command', { ttlMs: 1000 });
      clk.advance(999);
      assert.ok(reg.get('c', 'u'));
      assert.strictEqual(reg.get('c', 'u').expired, undefined);
    });

    it('returns { expired:true } ONCE past the TTL, then null (announce-once)', () => {
      const clk = fakeClock();
      const reg = new PendingRegistry({ now: clk.now });
      reg.set('c', 'u', 'pin_command', { ttlMs: 1000 });
      clk.advance(1001);

      const first = reg.get('c', 'u');
      assert.strictEqual(first.expired, true, 'first lookup after expiry flags it');
      assert.strictEqual(first.kind, 'pin_command', 'expired entry still carries its payload for the announce');

      // The expiring get() deletes it, so a second lookup is a clean miss —
      // the expiry is announced exactly once.
      assert.strictEqual(reg.get('c', 'u'), null);
    });

    it('defaults to a 5-minute TTL', () => {
      const clk = fakeClock();
      const reg = new PendingRegistry({ now: clk.now });
      reg.set('c', 'u', 'pin_command', {}); // no ttlMs
      clk.advance(DEFAULT_TTL_MS - 1);
      assert.ok(reg.get('c', 'u') && !reg.get('c', 'u').expired);

      reg.set('c', 'u', 'pin_command', {});
      clk.advance(DEFAULT_TTL_MS + 1);
      assert.strictEqual(reg.get('c', 'u').expired, true);
    });

    it('peek() does not expire or mutate', () => {
      const clk = fakeClock();
      const reg = new PendingRegistry({ now: clk.now });
      reg.set('c', 'u', 'pin_command', { ttlMs: 1000 });
      clk.advance(2000);
      assert.ok(reg.peek('c', 'u'), 'peek still sees the aged entry');
      assert.strictEqual(reg.peek('c', 'u').expired, undefined, 'peek never flags expired');
      assert.strictEqual(reg.size, 1, 'peek did not delete');
    });
  });
});
