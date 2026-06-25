# litectx ask — per-chat isolation on the memory axis (one shared instance)

**Filed:** 2026-06-25 · **Module:** M4 (litectx memory) · **Status:** ✅ DELIVERED + VALIDATED (litectx **0.21.0**, 2026-06-25) · **Unblocks:** M4 build
**Validated against:** published litectx **0.21.0** (POC, not a working tree — customer contract)

> **DELIVERED in litectx 0.21.0 (2026-06-25) + VALIDATED against the published artifact.** litectx mapped the per-call `scope` to the `fact`/`episode` `mem_scope.owner` (single-dim, exactly as decided): `recall`/`remember`/`get`/`reviewCandidates`/`promotionCandidates`/`recentMemory` all take a tenant `scope` (BM25 + KNN), `strictScope` now fails closed on the memory axis too (`code` exempt), and **`ctx.scoped(tenant)` binds every fenceable kind** — so one `strictScope` instance + `scoped(tenant)` is a complete multi-tenant store, no per-call scope to forget (multis's exact path). **Validation POC (`/tmp/m4-poc/validate-0210.mjs`, published 0.21.0, 16/16, failable):** the 0.20.0 Q2 leak is closed (A↛B, B↛A on facts); global tier visible to all; `get(other-tenant)`→null; promotion **and** review ladder fenced per tenant; bare strict `recall/remember({kind:'fact'})` throws; a non-strict control instance **still leaks** (proves the asserts can fail). Suite **526/526** on the `^0.20.0→^0.21.0` bump, `npm audit` 0. Scope note: validated the **BM25 path** (multis runs embeddings-off); the KNN fence is litectx's CI mutation-proof, not re-exercised here. **M4 build is now UNBLOCKED** (rip out `src/memory/*` → window→`episode`, durable→`fact`, condense→`promotionCandidates`, `/remember`→direct `fact` write).

## The need (stated; the API shape is litectx's call)

multis is multi-tenant on **one `LiteCtx` per process** (locked at M3: *"one instance/process; isolation is the per-CALL scope, never the instance owner"*). The **doc axis** already supports exactly this — `scope` / `ctx.scoped(scope)` / `strictScope`, the M3 ask litectx delivered. A single instance fences one chat's uploads from another's, and "a forgotten scope is impossible" via the bound `scoped()` view.

The **memory axis (`fact` / `episode`) does not.** Those kinds isolate **only** via the instance-level `owner` / `session` set at construction; they **ignore the per-call `scope` arg and the `scoped()` view** (the view binds the doc axis only — its own doc says it "mirrors how the memory axis binds owner/session once on the instance"). So a single shared instance **cannot fence per-chat facts/episodes**.

This blocks M4: moving multis's memory off the M3 interim (memory faked as scope-tagged `kind:'doc'` rows) onto the real `episode`/`fact` kinds — which is required to use the promotion ladder (`promotionCandidates`/`reviewCandidates`) — **loses per-chat isolation**. It is also a **security boundary**, not a nicety: multis's model #6 requires customer memory fenced as untrusted (customer-vs-customer and customer-vs-owner).

**Requirement:** a single `LiteCtx` must be able to fence `fact`/`episode` recall **and** the ladder/recency queries (`promotionCandidates` · `reviewCandidates` · `recentMemory`) per tenant, the same way the doc axis fences via `scope`/`scoped()`, while keeping multis's "one instance/process, no per-call scope to forget." **How litectx exposes it is litectx's design call** (e.g. `scoped(scope)` binding the memory axis too, or per-call `owner`/`session` opts, or otherwise) — multis does not prescribe the API (Principle 8).

## Tenant model (multis's input — DECIDED 2026-06-25: single-dim, `tenant → owner`)

litectx's memory axis has two isolation dims — `owner` (durable actor, cross-session) and `session` (volatile run). **multis maps to ONE: the tenant string → `owner`. `session` is left at the instance default (multis never sets it).**

Why single-dim is the faithful mapping:
- multis's only tenant key is `chatId`, and it has no cross-network customer identity (Beeper exposes none; `list_inbox` can't reconcile WhatsApp-X and Telegram-X). So **a customer ≡ one chat** — `owner='user:<chatId>'` fences both their facts and episodes; a second key would just duplicate the first.
- The **owner/admin** case wants durable facts available across all the owner's chats — and that falls out for free, because **`fact`s ignore `session`** (`owner='admin'` is cross-chat automatically). No second dim needed.
- This keeps the **bind-once** property pure: `ctx.scoped('user:<chatId>')` (the view multis already uses for docs) fences *every* kind with one string — nothing extra to thread, no per-call footgun.

The `session` dim earns its keep only under **concurrent agents** (several runs building separate working memory at once) — which multis is not (one bot, serial poll) and the M5/M6 roadmap doesn't add. **two-dim is NOT more secure** (all tenant isolation rides `owner`; `session` only subdivides one actor's own notes — same principal both sides) and **NOT faster** (a second indexed predicate is free; for customers the two keys are identical, so it narrows nothing). Its only real effect is keeping one owner's separate conversations from mixing in recall — a marginal context-tidiness gain for a single owner.

**Additive upgrade path:** moving to two-dim later is "start passing `session`" — no rework. So multis adopts single-dim now and flips **only if/when it runs concurrent agents**; until then the second key buys no security and no speed.

So for multis: **`scoped(<tenant-string>)` must drive `mem_scope.owner` for `fact`/`episode` (and the ladder/recency queries); `session` stays untouched.** If litectx wants to stay general for two-dim hosts it may *also* accept `scoped({owner, session})` — but that is litectx's generality call, not a multis requirement.

## Acceptance

On **one** instance:
- a tenant-scoped write + recall of a `fact`/`episode` returns **that tenant's ∪ global** memory only — never another tenant's;
- `promotionCandidates` / `reviewCandidates` / `recentMemory` respect the **same** fence;
- global (ownerless) memory stays visible to every tenant;
- mirrors the doc-axis fail-closed option (a missing scope is catchable, not a silent see-everything) so multis can keep `strictScope`-style discipline across all kinds.

## Evidence (POC, litectx 0.20.0, `/tmp/m4-poc` — throwaway)

- **Q1 — ladder works.** Real episode traffic → `promotionCandidates(10)` surfaced *only* the hot episode (12 recalls); warm (3) and cold (0) excluded. `reviewCandidates(5)` surfaced *only* the agent fact crossing threshold; fresh-agent and human-trust facts excluded. Every negative control held.
- **Q2 — the gap.** `ctx.scoped('user:B').recall(q,{kind:'fact'})` returned **both** chat B's and chat A's facts; `remember(id,text,{kind:'fact',scope:'user:A'})` ignored `scope`. Cross-tenant leak on one shared instance.
- **Q3 — works only per-instance.** Two `LiteCtx` (`owner:'user:A'` / `'user:B'`) on the **same** dbPath isolate correctly (A sees A ∪ global, B sees B ∪ global; no corruption). But that is **one instance per chat** — the workaround multis rejected at M3.

## What multis will NOT do (Principle 1 / 4 / 8)

No per-chat-instance workaround (papering over the locked one-instance model). The M4 build is designed and the ladder is POC-validated; **multis waits for the release**, then resumes (rip out `src/memory/*` → window→`episode`, durable→`fact`, condense→`promotionCandidates`, `/remember`→direct `fact` write) and validates against the published artifact.
