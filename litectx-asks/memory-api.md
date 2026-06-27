# litectx ask — multis memory API (consolidated)

**Filed:** 2026-06-27 · **Modules:** M4 (litectx memory) + M5 (context-engineering)
**Status:** ⛔ OPEN · **Blocks:** R3 blocks M4 completion (retiring `recent.json`); the rest are sequenced (see Priority)
**Found against:** published litectx **0.22.0** (= npm latest)
**Supersedes:** `recent-memory-by-scope.md` (folded in as **§R3**)

> **Why one ask.** multis filed the memory axis one capability at a time — isolation (recall, **delivered 0.21.0**), forget (delete, **delivered 0.22.0**), recency (open). Rather than continue the drip, this is the **complete** set of memory capabilities multis foresees needing from litectx across M4 (now) and M5 (next), so litectx can design **one coherent memory API** instead of bolting on verbs. Each item states the **need** + a **preferred shape** (litectx owns the final API — Principle 8) + a **failable acceptance**. Priority is labelled; **not all are blocking**.

## Shared invariants (already true for recall/forget — every item below inherits them)
One process-wide `LiteCtx`; tenant-fenced on `mem_scope.owner`; a bound `scoped(tenant)` carries the scope; reads union `scope ∪ GLOBAL`; expiry-aware; **fail-closed under `strictScope`** (a missing scope throws, never "see everything"). multis runs one instance/process and never wants a per-call scope it can forget.

## Priority / sequence
| Item | What | Priority |
|------|------|----------|
| **R3** | Time-ordered recency on the memory axis | ⛔ **BLOCKS M4** — needed first (retires `recent.json`) |
| **R4** | Semantic (KNN) recall on the memory axis | 🟡 M4-class — multis is enabling embeddings; consume as delivered |
| **W4** | Update / supersede a fact by stable key | 🟡 M4-class — stops re-stated facts piling up |
| **O1** | Per-scope memory count | 🟢 minor — powers `/memory`, `/docs` |
| **C1** | Budget-fit `assemble` on the memory axis | 🔵 **M5** — specced now for coherence; multis validates at M5 |
| **C2** | `summaryWindow` (compress long chats) | 🔵 **M5** — same |

litectx may deliver in any order, but **R3 unblocks the most** (it's the last piece of "multis keeps no homegrown memory store"). C1/C2 are specced now only so the memory API is designed whole — multis can't *validate* them until M5, so no rush to build ahead of that.

---

## R3 — time-ordered recency on the memory axis  ⛔ BLOCKING

**Need.** A **time-ordered** read of a tenant's `fact`/`episode` memory — newest first, **no FTS query** — fenced like `recall`/`forget`. Two consumers:
1. **`/memory`** ("show what I remember here") — list this chat's durable memory newest-first. No query → `recall` (needs terms) can't answer it.
2. **The conversation window** — multis still keeps `recent.json` (a per-chat last-N message window) *only* because litectx can't return "the last N episodes for this scope by time." Each exchange is already an `episode`; a recency read lets the agent's message history come straight from litectx and **`recent.json` is deleted**.

**Gap (0.22.0).** `recentMemory` is **doc-axis only** (its own doc: *"`fact`/`episode` … are not included — this is the doc axis only"*). `recall` needs a query; `promotionCandidates`/`reviewCandidates` are usage-ranked, not time-ordered; `get` is by-id. Nothing answers "newest N for this tenant."

**Preferred shape** (litectx decides):
```
recentMemory({ scope, kind, n, body })          // kind defaults to 'doc' (unchanged); 'episode'|'fact'|array opt-in
ctx.scoped(tenant).recentMemory({ kind, n })    // bound form
```
- newest-first by time — `occurred_at` (episodes, exists) / `created_at` (facts);
- tenant-fenced (`scope ∪ GLOBAL`), expiry-aware, fail-closed under `strictScope`;
- **must NOT log a recall** (recency is not query-demand → must not inflate the promotion `use` signal — the doc-axis `recentMemory` already takes this care);
- back-compat: `kind` omitted → today's doc-axis behavior, byte-identical.

**⚠ Load-bearing detail (or it won't actually replace `recent.json`).** Episodes are stored as **combined `User:/Assistant:` exchanges**, but the agent loop replays **ordered turns**. The recency read must return episodes in a shape multis can feed as **faithful conversation history** — minimally: text + `occurred_at` + any `meta.role`, time-ordered, so a multi-turn thread reconstructs in order without lossy string-parsing. multis will **POC this against the delivered verb** before deleting `recent.json`; if the exchange-vs-turn granularity can't reconstruct, the window is the one piece that stays multis (and we say so).

**Acceptance (failable).** One `strictScope` instance, tenants A/B (A a prefix of B):
- `scoped(A).recentMemory({ kind:['fact','episode'], n })` → A's rows newest-first, **none of B's**, GLOBAL included, expired excluded;
- ordering reflects write/occurred time (a later write ranks first);
- no-scope under `strictScope` throws;
- it does **not** bump promotion `use` (a recency read then `promotionCandidates` shows no count change) — the failable control: a *recall* of the same rows DOES bump it.

---

## R4 — semantic (KNN) recall on the memory axis  🟡

**Need.** multis is **enabling embeddings** (today it runs embeddings-off / BM25-only). Live test surfaced the lexical ceiling: stored *"you are male"*, queried *"am I a **woman**?"* → zero match (no shared token), bot said "no info." Semantic recall (`woman` ↔ `male`/`female`) closes that.

**Gap / question (0.22.0).** litectx has KNN; what multis needs **confirmed**: with embeddings on, does memory-axis `recall(kind:['fact','episode'])` **blend BM25 + KNN** while staying tenant-fenced (`mem_scope.owner`), `scope ∪ GLOBAL`, expiry-aware, fail-closed — i.e. KNN does **not** bypass the fence? And does the facts-first ordering survive the blend?

**Preferred shape.** No new verb expected — `recall` gains/【confirms】a semantic path under embeddings-on, same signature, same fence. If a knob is needed (e.g. `mode: 'hybrid'|'bm25'|'knn'`), litectx's call.

**Acceptance (failable).** Embeddings on, tenants A/B: a query semantically related but lexically disjoint from A's fact retrieves it; **B's semantically-related fact is NOT returned** (KNN respects the fence — the security-critical case); a nonsense query returns nothing (control). Same suite passes embeddings-off (BM25 fallback unbroken).

---

## W4 — update / supersede a fact by stable key  🟡

**Need.** Memory is append-only, so **re-stated facts pile up**: live test went age 44→45, deadline Aug 20→Aug 23, "muscular by 45"→"by 46". Both versions persist and can both surface on recall → contradiction. multis wants to **overwrite** a prior value when the user supersedes it.

**Split (honest).** *Detecting* "same subject, new value" is LLM/multis's job — not litectx's. What multis needs from litectx is the **mechanism** to act on that decision: replace a fact's text/meta in place, tenant-fenced.

**Gap (0.22.0).** Promotion already **upserts** by deriving a stable id (`fact-${path}`), so `remember(sameId, …)` overwriting is *implied* — but it's not a **documented, first-class** update primitive, and there's no tenant-fenced "find the fact for this key" to locate the id to overwrite.

**Preferred shape** (litectx decides — one or both):
```
remember(id, text, { kind:'fact', … })          // GUARANTEE + document: same id overwrites (tenant-fenced upsert)
update(id, { text?, meta?, expiresAt? }, scope)  // explicit in-place edit, fail-closed, returns updated|null-if-not-in-scope
```
- tenant-fenced (can't update another tenant's row, can't update the shared tier from a chat scope — the forget-style correctness trap);
- multis supplies the stable key (e.g. a normalized subject slug it computes); litectx just honors upsert/update on it.

**Acceptance (failable).** `remember('fact:subject', 'v1', {scope:A})` then `remember('fact:subject', 'v2', {scope:A})` → `recall`/`recentMemory` returns **only v2** (one row, not two); the same id under `scope:B` is a **separate** row (no cross-tenant clobber); update of a non-existent/out-of-scope id under `strictScope` fails closed.

---

## O1 — per-scope memory count  🟢

**Need.** `/memory` and `/docs` want "you have **N** facts / **M** episodes here" without pulling every row. Today only global `store.count()` exists.

**Preferred shape.** `count({ scope, kind })` (and/or `scoped(t).count({kind})`), tenant-fenced, expiry-aware. Cheap (a `SELECT count(*)`).

**Acceptance.** `scoped(A).count({kind:'fact'})` equals the number of A's live facts, excludes B's and excludes expired.

---

## C1 — budget-fit `assemble` on the memory axis  🔵 M5

**Need.** M5 gives multis the budget-fitting it never had — fit recalled memory + doc chunks + conversation into a token budget, **recency-preserving**, without ad-hoc prompt stuffing.

**Gap / confirm.** M5's planned `assemble`/`unitAssembler`/`unitTrimmer` (with bare-agent `toUnits`/`fromUnits`/`harvestKey`) — does it cover the **memory kinds** (`fact`/`episode`), stay **tenant-fenced**, and preserve **recency + atomic bundles** (don't split an exchange, don't drop the newest)? If it's doc-axis-first like `recentMemory` was, multis needs it widened to memory.

**Acceptance (at M5).** A long synthetic chat for tenant A assembles within a set token budget; the **newest** episodes/facts survive trimming, the oldest drop; no B content appears; an atomic exchange is never half-included.

---

## C2 — `summaryWindow` (compress long chats)  🔵 M5

**Need.** For chats longer than the budget, a rolling **compressed** summary of older turns so continuity survives beyond the raw window — the durable counterpart to R3's recent slice.

**Gap / confirm.** The planned `summaryWindow` — memory-axis aware, tenant-fenced, and **does it write its summary back as a litectx unit** (so it's itself recallable/forgettable under the same fence) rather than an opaque blob multis has to store?

**Acceptance (at M5).** Past the window, a tenant-A summary captures older turns, is fenced to A, recallable, and cleared by `forget(scope:A)`.

---

## multis status while OPEN (interim, non-blocking for the ladder)

The durable ladder (episode→fact promotion, `/remember`, `/forget`, relevance recall) **ships and is live** — increments 1+2 complete, validated against 0.21/0.22. What waits on **R3**:
- `recent.json` is **KEPT** as the conversation thread (the agent loop replays it);
- `/memory` shows the **recent conversation window** (honest kept data), not a durable-fact list — facts surface on demand via `recall_memory`.

**multis is blocking the M4 *completion* (and the 0.18.0 cut) on R3** — per the customer contract, blocking on the litectx release IS the validation; multis will not bound/retain `recent.json` as a permanent workaround (that's the homegrown store M4 exists to delete). On delivery + validation against the **published** artifact, multis: points `/memory` at `recentMemory({kind:['fact','episode']})`, sources the agent history from episode-recency, **deletes `recent.json` + the `ChatMemoryManager` window code**, and consumes R4/W4/O1 as their pieces land. C1/C2 are consumed at M5.
