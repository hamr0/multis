/**
 * litectx `writeGate` adapter (the CE-PRD §10.1 slot) — bounds CUSTOMER memory
 * writes per-scope so a spamming contact can't bloat the store or burn embeds.
 *
 * The reply-side `RateLimiter` caps how many LLM ANSWERS a sender gets; this is
 * its write-side twin — it caps how many rows a sender can make us STORE. It must
 * use a SEPARATE limiter instance: `consume()` mutates rolling-window state, so
 * sharing one limiter with the reply path would double-count and corrupt both.
 *
 * Only writes carrying `meta.writer` are counted — multis stamps that on CUSTOMER
 * episode writes (see rememberEpisodeFor). Owner episodes, `/remember` facts, doc
 * ingest, and promotion sweeps omit it and pass straight through, ALWAYS (the owner
 * is never throttled; internal writes never drop). A denied write throws litectx's
 * `WriteDeniedError` BEFORE commit (no embed, no row); the caller drops it silently.
 * The deny is audited HERE — the gate is the single choke point every write passes,
 * so one line per blocked write regardless of which call site issued it.
 *
 * @param {object}   deps
 * @param {import('./rate-limit').RateLimiter} [deps.limiter]  dedicated write limiter (omit → inert)
 * @param {(entry: object) => void}            [deps.audit]    sink for a denied write (e.g. logAudit)
 * @returns {{ check(action: object): Promise<{outcome:'allow'|'deny', reason?:string}> }}
 */
function makeWriteGate({ limiter, audit } = {}) {
  return {
    async check(action) {
      const writer = action && action.meta && action.meta.writer;
      // No writer key (owner/fact/doc/promotion) or no limiter wired → never gated.
      if (!writer || !limiter) return { outcome: 'allow', reason: 'exempt' };
      const v = limiter.consume(writer);
      if (v.allowed) return { outcome: 'allow' };
      if (audit) audit({ action: 'write_denied', chatId: writer, kind: action.kind, scope: v.scope });
      return { outcome: 'deny', reason: `write-limit:${v.scope}` };
    },
  };
}

module.exports = { makeWriteGate };
