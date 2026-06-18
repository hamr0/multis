# litectx ask — a recency view for written-memory rows, scope-fenced

**From:** multis (first baresuite customer), module **M3**.
**Against:** litectx **0.17.1** (installed npm artifact; behaviour proven below, not asserted).
**Date:** 2026-06-18.
**Severity:** LOW — a UX fallback, not a correctness or security gap. FTS recall is unaffected.
**Status:** FILED — multis dropped one legacy fallback during the M3 rewire; this records the
capability gap rather than papering over it with raw-SQL into litectx's store.

---

## Finding

The legacy multis store backed the `recall_memory` agent tool with two queries:

1. **FTS search** of conversation-memory rows for the query terms, scope-fenced.
2. **Recency fallback** (`recentByType`) — when the FTS match was empty (e.g. an
   all-stopword query like *"what did I say"*), it returned the most recent memory
   rows for the scope so the agent still had something to ground on.

M3 moves all storage to litectx. The FTS path maps cleanly to
`recall(q, { kind:'doc', scope, body:true })` filtered to memory rows. **The recency
fallback has no clean litectx primitive:**

- `recall` with an empty FTS match returns `[]` — `_rankKind(match, …)` short-circuits
  to `[]` when `match` is falsy (`src/index.js:449`). No recency tie-break.
- `recentActivity({ days, scope? })` is the "what was I working on" view, but it reads
  the **witnessed-edit** log — and a cold `ingest()` logs no edit ("loading isn't
  editing", `src/index.js:805-808`). Memory rows written via `ingest` therefore never
  appear there, and it isn't scope-fenced.

So preserving the fallback would require reaching past the wrapper into
`ctx.store` with raw SQL keyed on litectx's schema (`meta.type`, scope, an insertion
timestamp) — a coupling the thin-wrapper contract (multis shapes POLICY only) forbids.

## What multis did in the meantime

Dropped the fallback in `src/context/searchMemory()` and flagged it in-code. FTS recall
still works for any query carrying a non-stopword term, which covers the common case.
No security or data-loss impact — only the all-stopword query now returns
"No matching memories found" instead of recent context.

## The ask

A scope-fenced recency view over written-memory rows. Either shape works for multis:

```js
// (a) a dedicated recent() for memory kinds, scope-fenced + expiry-aware
ctx.recentMemory({ scope, n })            // → [{ path, body?, createdAt, ... }]

// (b) or: recall falls back to recency within a kind when the FTS match is empty
ctx.recall(q, { kind:'doc', scope, body:true, recentOnEmpty:true })
```

Constraints that matter to multis:
- **Scope-fenced** the same way `recall({scope})` is (`scope ∪ null-global`) — the
  fallback must not leak another tenant's memory (#6).
- **Expiry-aware** — never surface rows past their `expiresAt` (R5), same as recall.
- Ordered by recency (newest first), capped at `n`.

## Out of scope / non-asks

- The FTS recall path, scope fence, `expiresAt`/`purge`, and the doc-vs-memory `meta`
  filter are all delivered and validated through the wrapper
  (`test/integration/context.test.js`, green against 0.17.1). This ask is only the
  empty-match recency tie-break.
- Not blocking: M3 ships without it; this is a fast-follow nicety, naturally revisited
  with the M4 memory-policy redesign (promotion ladder).
