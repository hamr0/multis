# litectx ask — time-ordered memory recency for `fact`/`episode` (`recentMemory` on the memory axis)

**Filed:** 2026-06-27 · **Module:** M4 (litectx memory) · **Status:** ⛔ OPEN · **Blocks:** finishing `recent.json` removal + `/memory` list (both interim'd, non-blocking for the ladder)
**Found against:** published litectx **0.22.0** (= npm latest)

> **Third memory-axis ask, after `memory-scope-isolation` (recall, DELIVERED 0.21.0) and `memory-scope-forget` (delete, DELIVERED 0.22.0).** Those gave per-tenant *relevance* recall and *delete*. This is the per-tenant *recency* read — "give me this tenant's latest memory, newest first, without a query." It is the last piece that lets multis retire its homegrown `recent.json` conversation window.

## The need (stated; API shape is litectx's call — Principle 8)

multis needs, on one shared `LiteCtx`, a **time-ordered** read of a tenant's `fact`/`episode` memory — newest first, no FTS query — tenant-fenced exactly like `recall`/`forget` (owner on `mem_scope.owner`, `scope ∪ GLOBAL`, expiry-aware, fail-closed under `strictScope`).

Two concrete consumers in M4:
1. **`/memory` ("show what I remember here")** — list this chat's durable memory newest-first. There is no query, so `recall` (FTS-ranked, needs terms) cannot answer it.
2. **The conversation thread** — multis still keeps `recent.json` (a per-chat last-N window) ONLY because litectx can't return "the last N episodes for this scope by time." Each exchange is already written as an `episode`; a recency read would let the agent's message-history come straight from litectx and `recent.json` could be deleted (the homegrown store finally goes to zero).

## The gap (grounded in 0.22.0)

`recentMemory` exists but is **doc-axis only** — its own doc: *"`fact`/`episode` (the owner/session axis) and `code`/files are not included — this is the doc axis only."* It returns directly-written `doc` rows by `created_at`. So there is no recency read for the memory kinds the ladder uses.

(`recall` is FTS-relevance + needs a query; `promotionCandidates`/`reviewCandidates` are usage-ranked, not time-ordered; `get` is by-id. None answer "newest N for this tenant.")

## Preferred shape (multis's input — litectx decides)

Extend recency to the memory axis — either by widening `recentMemory` to accept `kind: 'fact' | 'episode' | ['fact','episode']`, or a sibling verb:

```
recentMemory({ scope, kind, n, body })   // kind defaults to 'doc' (unchanged); 'episode'/'fact'/array opt-in
ctx.scoped(tenant).recentMemory({ kind, n })   // bound form (no scope to forget)
```

- ordered by time newest-first — `occurred_at` for episodes (it already exists), `created_at` for facts;
- tenant-fenced on `mem_scope.owner` (`scope ∪ GLOBAL`), expiry-aware, **fail-closed** under `strictScope` (missing scope throws) — identical to the read/forget axes already shipped;
- does **not** log a recall (recency is not query-demand — must not inflate the promotion `use` signal; the existing doc-axis `recentMemory` already takes this care);
- back-compat: `kind` omitted → today's doc-axis behavior, byte-identical.

## Acceptance (failable)

On one `strictScope` instance, two tenants A/B (A a prefix of B):
- `scoped(A).recentMemory({ kind: ['fact','episode'], n })` returns A's rows newest-first, **none of B's**, GLOBAL included, expired excluded;
- ordering reflects write/occurred time (a later write ranks first);
- no-scope under `strictScope` throws;
- it does **not** bump promotion `use` (a recency read followed by `promotionCandidates` shows no count change) — the failable control: a *recall* of the same rows DOES bump it.

## multis status while OPEN (interim, non-blocking)

The ladder ships now (increment 2 complete). Until this lands:
- **`recent.json` is KEPT** as the conversation thread (the agent loop replays it across messages);
- **`/memory` shows the recent conversation window** (honest, kept data) instead of a durable-fact list — durable facts still surface on demand via the `recall_memory` tool / `recallMemory`.

When delivered + validated against the published artifact, multis: points `/memory` at `recentMemory({kind:['fact','episode']})`, sources the agent's message history from episode-recency, and **deletes `recent.json` + the remaining `ChatMemoryManager` window code** — closing M4's "retire the homegrown store" to zero (only the raw daily logs remain, by design).
