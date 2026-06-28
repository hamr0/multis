# litectx ask — multis memory API (consolidated)

**Filed:** 2026-06-27 · **Modules:** M4 (litectx memory) + M5 (context-engineering)
**Status:** ✅ M4 items RESOLVED — R3 + R4 + O1 (litectx 0.23.0) + W4 (litectx 0.24.0) DELIVERED + VALIDATED + CONSUMED (2026-06-27). C1/C2 remain OPEN for M5. (Note: at 0.24.0 `expiresAt` was doc-axis only — episodes 30d-prune, facts durable — so multis retired its 90/365 retention. **Configurable episode window — DELIVERED + CONSUMED (litectx 0.25.0, 2026-06-28).** litectx shipped `episodeWindowDays` (a `LiteCtx` constructor option, default 30) — an **instance-level** window (not the per-episode `expiresAt` first imagined) that drives BOTH the write-time prune AND the promotion floor (one coupled clock). multis threads `config.memory.episode_window_days` (**default 90, all chats**) into `new LiteCtx({ episodeWindowDays })`. Owner decision 2026-06-28: **one knob, 90d for everyone** (not the per-role 90/365 split, not a per-customer prune) — the window already bounds idle chats (an inactive chat's episodes age out), and `/forget` stays the manual per-chat clear, so multis adds **no** inactivity-autoprune logic. Buys long-tail continuity for sporadically-used chats; durability stays the promotion ladder. ⚠ Coupling: 90d also lengthens the promotion window (one window, no retain-90/promote-30 split).)
**Found against:** published litectx **0.22.0** (= npm latest at filing)
**Supersedes:** `recent-memory-by-scope.md` (folded in as **§R3**)

> **Why one ask.** multis filed the memory axis one capability at a time — isolation (recall, **delivered 0.21.0**), forget (delete, **delivered 0.22.0**), recency (open). Rather than continue the drip, this is the **complete** set of memory capabilities multis foresees needing from litectx across M4 (now) and M5 (next), so litectx can design **one coherent memory API** instead of bolting on verbs. Each item states the **need** + a **preferred shape** (litectx owns the final API — Principle 8) + a **failable acceptance**. Priority is labelled; **not all are blocking**.

## Shared invariants (already true for recall/forget — every item below inherits them)
One process-wide `LiteCtx`; tenant-fenced on `mem_scope.owner`; a bound `scoped(tenant)` carries the scope; reads union `scope ∪ GLOBAL`; expiry-aware; **fail-closed under `strictScope`** (a missing scope throws, never "see everything"). multis runs one instance/process and never wants a per-call scope it can forget.

## Priority / sequence
| Item | What | Priority |
|------|------|----------|
| **R3** | Time-ordered recency on the memory axis | ✅ **CONSUMED (0.23.0)** — retired `recent.json` |
| **R4** | Semantic (KNN) recall on the memory axis | ✅ **CONSUMED (0.23.0)** — embeddings on, tenant-fence proven |
| **W4** | Update / supersede a fact by stable key | ✅ **CONSUMED (0.24.0)** — same-subject supersession on `/remember` |
| **O1** | Per-scope memory count | ✅ **CONSUMED (0.23.0)** — powers `/memory` |
| **C1** | Budget-fit `assemble` on the memory axis | 🔵 **M5** — specced now for coherence; multis validates at M5 |
| **C2** | `summaryWindow` (compress long chats) | 🔵 **M5** — same |

litectx may deliver in any order, but **R3 unblocks the most** (it's the last piece of "multis keeps no homegrown memory store"). C1/C2 are specced now only so the memory API is designed whole — multis can't *validate* them until M5, so no rush to build ahead of that.

---

## R3 — time-ordered recency on the memory axis  ✅ CONSUMED (litectx 0.23.0)

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

## R4 — semantic (KNN) recall on the memory axis  ✅ CONSUMED (litectx 0.23.0)

**Need.** multis is **enabling embeddings** (today it runs embeddings-off / BM25-only). Live test surfaced the lexical ceiling: stored *"you are male"*, queried *"am I a **woman**?"* → zero match (no shared token), bot said "no info." Semantic recall (`woman` ↔ `male`/`female`) closes that.

**Gap / question (0.22.0).** litectx has KNN; what multis needs **confirmed**: with embeddings on, does memory-axis `recall(kind:['fact','episode'])` **blend BM25 + KNN** while staying tenant-fenced (`mem_scope.owner`), `scope ∪ GLOBAL`, expiry-aware, fail-closed — i.e. KNN does **not** bypass the fence? And does the facts-first ordering survive the blend?

**Preferred shape.** No new verb expected — `recall` gains/【confirms】a semantic path under embeddings-on, same signature, same fence. If a knob is needed (e.g. `mode: 'hybrid'|'bm25'|'knn'`), litectx's call.

**Acceptance (failable).** Embeddings on, tenants A/B: a query semantically related but lexically disjoint from A's fact retrieves it; **B's semantically-related fact is NOT returned** (KNN respects the fence — the security-critical case); a nonsense query returns nothing (control). Same suite passes embeddings-off (BM25 fallback unbroken).

---

## W4 — update / supersede a fact by stable key  ✅ DELIVERED + VALIDATED + CONSUMED (litectx 0.24.0, 2026-06-27)

**Resolution.** litectx 0.24.0 shipped the **upsert shape**: `remember(id, text, …)` is a documented, tenant-fenced upsert by `(scope, id)` — same id under the same scope replaces in place; same id under a different scope is a separate row. litectx chose the `remember`-is-the-upsert option (not a separate `update()` verb — the ask permitted either). The owner-qualified physical key fences a bare `get` by construction; a reserved separator (`\x1F`) in an id/scope is rejected on write; a one-time auto-migration re-keys 0.21–0.23 rows. multis validated against the **published** 0.24.0 artifact (POC: upsert-in-place, cross-tenant separation, public-id round-trip, scoped get — all pass; the upsert mechanic mutation-proven via the integration test) and built the same-subject judge on top (`src/memory/supersede.js`). **The "same subject, new value" detection stayed multis's job, as scoped.** Suite 554, audit 0.

**Need (original).** Memory is append-only, so **re-stated facts pile up**: live test went age 44→45, deadline Aug 20→Aug 23, "muscular by 45"→"by 46". Both versions persist and can both surface on recall → contradiction. multis wants to **overwrite** a prior value when the user supersedes it.

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

## O1 — per-scope memory count  ✅ CONSUMED (litectx 0.23.0)

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

## multis status (M4 items resolved)

The durable ladder (episode→fact promotion, `/remember`, `/forget`, relevance recall) **ships and is live**, and all M4 memory-axis asks are now **consumed against the published artifacts**:
- **R3 (0.23.0):** `recent.json` + the `ChatMemoryManager` window code are **DELETED** — the agent conversation thread and `/memory` source from `recentMemory({kind:['fact','episode']})` (homegrown memory store → zero, only the raw daily log remains);
- **O1 (0.23.0):** `/memory` shows durable facts + recent episodes with a per-kind count header;
- **R4 (0.23.0):** semantic/KNN recall on (`config.memory.semantic`, default on), tenant-fence proven under embeddings;
- **W4 (0.24.0):** `/remember` runs a same-subject supersession judge — a restated fact overwrites in place (tenant-fenced upsert), fail-toward-keep.

**Per-episode TTL was NOT delivered as a knob** — litectx clarified `expiresAt` is doc-axis only (episodes prune at a fixed 30-day window, facts durable until `forget`); multis **retired its homegrown 90/365 retention** rather than carry a 30d-interim, with durability provided by the promotion ladder. Per the customer contract, blocking on each litectx release WAS the validation — no `recent.json`, TTL, or supersede workaround ever shipped. **The 0.18.0 cut no longer waits on litectx** (the only remaining gate is the owner-driven live T4). C1/C2 are consumed at M5.
