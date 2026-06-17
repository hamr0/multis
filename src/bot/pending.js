'use strict';

/**
 * PendingRegistry — the single store for "the next message from this
 * conversation means something other than a normal query."
 *
 * Replaces three parallel, drifting subsystems (pinManager.pendingCommands,
 * human-channel's pendingHumanResponses, and the five config._pending* objects)
 * with one mechanism: one key convention, one TTL policy, one lookup at the top
 * of the router.
 *
 * The registry is deliberately dumb — it stores, expires by TTL, and returns.
 * It knows nothing about what an entry means. The router interprets each entry
 * by its `kind`. That payload-agnosticism is what lets both flavours of pending
 * state share one store:
 *   - "stored continuation" states (PIN command entry, mode/index pickers): the
 *     entry carries `data` the router acts on when the reply arrives;
 *   - "parked promise" states (gate PIN/CONFIRM/approval challenges): the entry
 *     carries a `resolve` fn that the router calls to unblock the awaiting gate.
 *
 * Key = `chatId:senderId`. Keying on the (chat, sender) tuple — not senderId
 * alone — kills the cross-chat collisions and Beeper senderId drift that the
 * old senderId-only / chatId-only mix suffered.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

class PendingRegistry {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] - clock injection point for deterministic
   *        tests; defaults to Date.now.
   */
  constructor({ now = () => Date.now() } = {}) {
    this.entries = new Map(); // key -> { kind, ttlMs, createdAt, ...payload }
    this._now = now;
  }

  static key(chatId, senderId) {
    return `${chatId}:${senderId}`;
  }

  /**
   * Register a pending interaction, overwriting any existing entry for this
   * conversation.
   *
   * @param {string} chatId
   * @param {string} senderId
   * @param {string} kind     - discriminator the router dispatches on
   * @param {object} [payload] - entry data. Two fields are read by the
   *        registry/router; everything else is opaque:
   *          - ttlMs    {number}  lifetime; defaults to 5 min
   *          - match    {(text)=>boolean}  optional; "does this reply belong to
   *                     me?" The router consumes the message only when it matches
   *                     (e.g. PIN entry matches /^\d{4,6}$/), so a non-matching
   *                     message (a /command, an unrelated query) falls through
   *                     instead of being swallowed.
   */
  set(chatId, senderId, kind, payload = {}) {
    const ttlMs = payload.ttlMs ?? DEFAULT_TTL_MS;
    this.entries.set(PendingRegistry.key(chatId, senderId), {
      ...payload,
      kind,
      ttlMs,
      createdAt: this._now(),
    });
  }

  /**
   * Look up the entry for a conversation.
   *   - no entry            → null
   *   - live entry          → the entry
   *   - aged past its TTL    → deletes it and returns { ...entry, expired:true }
   *                            ONCE, so the router can announce the expiry
   *                            ("that prompt expired — re-send the command")
   *                            instead of letting a late reply fall through to
   *                            the RAG pipeline as a search query.
   */
  get(chatId, senderId) {
    const k = PendingRegistry.key(chatId, senderId);
    const e = this.entries.get(k);
    if (!e) return null;
    if (this._now() - e.createdAt > e.ttlMs) {
      this.entries.delete(k);
      return { ...e, expired: true };
    }
    return e;
  }

  /** Non-mutating existence check (does not expire). */
  peek(chatId, senderId) {
    return this.entries.get(PendingRegistry.key(chatId, senderId)) || null;
  }

  clear(chatId, senderId) {
    this.entries.delete(PendingRegistry.key(chatId, senderId));
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { PendingRegistry, DEFAULT_TTL_MS };
