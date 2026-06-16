/**
 * Per-sender rate limiter for business-mode inbound. Each stranger message
 * drives an LLM round (plus a capture round), so an unbounded contact in a loop
 * is a cost/DoS amplifier. This bounds it per-sender (not global), with a short
 * burst window and a daily cap. On the cap we escalate to a human rather than
 * refuse outright, so a genuinely-busy customer still gets help.
 *
 * In-memory, rolling windows. State is per-process (resets on restart) — that's
 * fine: the goal is to stop runaway loops and bill amplification, not to be a
 * durable quota. A `now` function is injectable for deterministic tests.
 */

class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} [opts.burstPerMin] max messages per rolling 60s (0 = off)
   * @param {number} [opts.dailyPerSender] max messages per rolling 24h (0 = off)
   * @param {() => number} [opts.now] clock, defaults to Date.now
   */
  constructor({ burstPerMin = 10, dailyPerSender = 100, now } = {}) {
    this.burstPerMin = burstPerMin;
    this.dailyPerSender = dailyPerSender;
    this._now = now || (() => Date.now());
    this._hits = new Map();      // senderId → number[] (timestamps, ascending)
    this._notified = new Set();  // senderIds we've already escalated this block
  }

  /**
   * Try to consume one slot for a sender.
   * @returns {{allowed: boolean, scope?: 'burst'|'daily', notify?: boolean}}
   *   allowed=false carries the limit that tripped. notify=true exactly once per
   *   block streak (caller sends the canned reply + escalation only then).
   */
  consume(senderId) {
    const key = String(senderId);
    const now = this._now();
    const minAgo = now - 60_000;
    const dayAgo = now - 86_400_000;

    let hits = this._hits.get(key) || [];
    // Prune anything older than the longest window we track.
    hits = hits.filter(t => t > dayAgo);

    const inMinute = hits.filter(t => t > minAgo).length;
    const inDay = hits.length;

    let scope = null;
    if (this.dailyPerSender && inDay >= this.dailyPerSender) scope = 'daily';
    else if (this.burstPerMin && inMinute >= this.burstPerMin) scope = 'burst';

    if (scope) {
      this._hits.set(key, hits); // persist the pruned list
      const notify = !this._notified.has(key);
      if (notify) this._notified.add(key);
      return { allowed: false, scope, notify };
    }

    hits.push(now);
    this._hits.set(key, hits);
    this._notified.delete(key); // allowed again → re-arm the next escalation
    return { allowed: true };
  }

  /** Test/diagnostic helper. */
  _reset() { this._hits.clear(); this._notified.clear(); }
}

module.exports = { RateLimiter };
