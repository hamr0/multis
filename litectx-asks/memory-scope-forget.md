# litectx ask — tenant-scoped memory forget on the public API (`forget({ scope })`)

**Filed:** 2026-06-26 · **Module:** M4 (litectx memory) · **Status:** ✅ DELIVERED + VALIDATED (litectx **0.22.0**, 2026-06-27) · **Unblocks:** `/forget`
**Validated against:** published litectx **0.22.0** (POC `/tmp/m4-poc/validate-0220-forget.mjs`, **16/16**, failable — customer contract: the published artifact, not a working tree)

> **DELIVERED in litectx 0.22.0 + VALIDATED against the published artifact.** litectx added `forget({ scope })` + `ScopedView.forget()` exactly as asked — owner-fenced on `mem_scope.owner` (resolved via the same `_resolveMemWriteOwner`, so write/read/forget agree byte-for-byte), **tenant-only** (does NOT match `owner IS NULL`, so a chat forget never nukes the shared tier — the §3.4 correctness trap), `GLOBAL` clears only the shared tier, optional `kind` narrow, fail-closed under `strictScope`. It went **beyond** the ask by (a) rejecting the `scope`+`id/idPrefix/by` footgun (`scoped(A).forget({by})` would otherwise inject `scope:A` and wipe all of A) and (b) exposing `idPrefix` on the public surface. **Validation POC (16/16, failable, multis's exact path = one `strictScope` instance + `scoped(tenant)`, A a textual prefix of B):** `scoped(A).forget()` clears all of A and none of B; the shared KB survives; kind-narrow drops only episodes; `forget({scope:GLOBAL})` clears only the shared tier; `forget({})`/`forget({kind})`/`scoped(A).forget({by})` throw under strict; `forget(id)` back-compat holds; a non-strict ownerless control still wipes both (proves the asserts can fail). multis wired `ctx.scoped(scope).forget()` as `context.forgetMemory(scope)`, 2 integration cases green, **suite 531/531** on the `^0.21.0→^0.22.0` bump, audit 0. **`/forget` UNBLOCKED.**

> **Companion + delete-counterpart to `memory-scope-isolation.md` (DELIVERED 0.21.0).** That ask fenced the memory **read** axis per tenant (`recall`/`get`/`promotionCandidates`/`reviewCandidates`/`recentMemory` via `scope` / `scoped()`, owner-fenced on `mem_scope.owner`, fail-closed under `strictScope`). It deliberately did **not** include `forget` — so there was **no way to delete one tenant's memory** on a shared instance. This ask closed that one gap, symmetrically.

---

## 1. Problem (grounded in the then-installed 0.21.0 source)

multis runs **one `LiteCtx` per process**; tenant isolation is the per-CALL `scope`, never an instance owner (locked at M3). `/forget` ("clear this chat's memory") must delete **all of one tenant's** `fact` + `episode` rows and **none of any other tenant's**. The 0.21.0 public API offered no such path:

```js
// node_modules/litectx/src/index.js:785 (0.21.0)
forget(sel) {
  if (typeof sel === "string") return this.store.forgetMemory({ id: sel });      // exact id ONLY
  if (sel.kind == null && sel.by == null) throw new Error("forget(query) needs at least { kind } or { by }");
  return this.store.forgetMemory({ kind: sel.kind, provenance: sel.by });          // OWNER-BLIND
}
```

- **exact-id string** → can't bulk-clear a tenant: no list-all-ids-for-a-scope verb (`recall` is ranked + capped + needs a query term; `recentMemory` is doc-axis only). multis would have to keep its own per-scope id ledger — homegrown state, exactly what M4 deletes.
- **`{ kind, by }`** → `store.forgetMemory({ kind, provenance })` carried **no owner/scope**, so it reached **every** tenant. `forget({ kind: 'fact' })` wiped all customers' facts.
- **`ScopedView`** exposed `recall/get/recentMemory/reviewCandidates/promotionCandidates/ingest/remember` — **no `forget`**.
- **`store.forgetMemory`** selected by `id / idPrefix / kind / provenance` — **no owner column** in the selector at any layer.

This is a **security boundary**, not a nicety: multis model #6 fences customer memory as untrusted; a mis-scoped `/forget` deletes *another customer's* memory.

**Note on `idPrefix`:** `store.forgetMemory` supported `idPrefix` and isolated correctly even in the worst case (POC `inc1.mjs` check 4: `idPrefix:'user:1'` cleared `user:1`, spared `user:12`). But it was **not surfaced** on the public `forget()`, and multis would **not** reach into `ctx.store` to bypass the curated guard (the paper-over the customer contract forbids). And id-prefix fencing would be a *second, different* tenant key (by id) from the read axis's key (by `mem_scope.owner`) — asymmetric and fragile. The right fix fences forget on the **same `owner`** the read axis already uses.

---

## 2. The need (stated; final API shape was litectx's call — Principle 8)

A single `LiteCtx` must be able to **forget one tenant's written memory** (`fact` + `episode`), fenced on `mem_scope.owner`, the **same way** the read axis already fences `recall` / `promotionCandidates` / `reviewCandidates` / `recentMemory`. Specifically:

- a tenant-scoped forget removes **only** that owner's `fact` + `episode` rows — never another tenant's, never the shared/global tier;
- it is reachable from a **bound `scoped()` view** so the scope can't be forgotten (the bind-once property the read axis has);
- it is **fail-closed under `strictScope`**: a memory forget with a missing scope **throws**, so a tenant-blind wipe is unexpressible by omission;
- it leaves the existing `forget(id)` and `forget({ kind, by })` shapes intact (back-compat).

---

## 3. Preferred API (multis's input — litectx refined; ✅ shipped in 0.22.0)

### 3.1 `LiteCtx.forget(sel)` — `scope` branch

| call | deletes |
|---|---|
| `forget('mem-123')` *(string)* | one row by exact id — **unchanged** |
| `forget({ kind, by })` | by kind/provenance, **owner-blind** — owner-blind broad forms now **throw under `strictScope`** (fail-closed by omission); precise `id`/`idPrefix` exempt |
| **`forget({ scope })`** | **all `fact` + `episode` rows whose `mem_scope.owner` = scope** — the tenant's whole conversational memory |
| **`forget({ scope, kind })`** | that tenant's rows of one kind only (e.g. just `episode`) |

- `scope` accepts a **tenant string** (→ `mem_scope.owner = scope`) or **`GLOBAL`** (→ `mem_scope.owner IS NULL`, the shared tier) — identical resolution to the read axis (`_resolveMemWriteOwner`).
- `scope` combines **only** with `kind`; `scope`+`{id|idPrefix|by}` is **rejected** (litectx's added footgun guard — see the delivery note).

### 3.2 `ScopedView.forget(sel = {})` — bind the scope (multis's call site)

```js
forget(sel = {}) { return this._ctx.forget({ ...sel, scope: this._scope }); }
```

multis calls `ctx.scoped('user:<chatId>').forget()` — one bound handle, no per-call scope to forget.

### 3.3 Fail-closed resolution — mirrors `_resolveMemWriteOwner`

`GLOBAL` → null (shared tier); string → that owner; missing scope under `strictScope` → THROW. So forget, write, and read agree byte-for-byte.

### 3.4 Store layer — owner-fence the mem deletion (the read-fence SQL, applied to DELETE)

> **Forget fences to the tenant ONLY — NOT "tenant ∪ global".** `recall`/`promotionCandidates` use `(s.owner IS NULL OR s.owner = @memOwner)` so a tenant *reads* its own rows **plus** the shared tier. A *forget* must delete **exactly** the named owner — a tenant forget that also matched `s.owner IS NULL` would **delete the shared/global memory for everyone**. So the forget clause is the stricter `s.owner = @memOwner` (tenant), or `s.owner IS NULL` **only** when `scope === GLOBAL` was explicitly passed.

```sql
-- TENANT forget (scope = 'user:<id>'):  owner must equal the tenant exactly
DELETE FROM mem
 WHERE path IN (
   SELECT m.path FROM mem m
   JOIN mem_scope s ON s.path = m.path
   WHERE s.owner = @memOwner                       -- exact tenant; NOT "OR s.owner IS NULL"
     AND (@kind IS NULL OR m.kind = @kind)          -- optional kind narrow
 );
-- GLOBAL forget (scope = GLOBAL):  only the shared tier (owner IS NULL, LEFT JOIN)
```

then cascade the sidecars (`mem_text` / `mem_meta` / `mem_scope`) by the same paths. A "delete every owner" mode must **not** exist — that is `reset()`'s job (§6).

**Scope of deletion:** `forget({ scope })` is **memory-axis only** (`fact`+`episode` for that owner); it does **NOT** touch the tenant's `doc`/blob uploads (`doc_scope.scope`, a separate axis — `/forget` clears conversation memory, not documents), the global tier (unless `scope: GLOBAL`), other tenants, `stash` (`evict`'s domain), or `code`/file rows.

---

## 4. Acceptance (failable test cases — all ✅ validated against published 0.22.0)

On **one** `new LiteCtx({ strictScope: true })` with A a textual prefix of B (`A='user:1'`, `B='user:12'`):

1. **Isolation (security control):** `ctx.scoped(A).forget()` removes all of A's `fact`+`episode` and **none** of B's. *(Neg control: B's rows still recall.)* ✅
2. **Kind narrow:** `forget({ scope: A, kind: 'episode' })` removes A's episodes only; A's facts survive. ✅
3. **Global tier:** a tenant forget leaves `GLOBAL` memory intact; `forget({ scope: GLOBAL })` removes only the shared tier. ✅
4. **Doc axis untouched:** A's ingested `doc` rows still recall after `scoped(A).forget()`. *(covered by the wrapper's separation; multis docs ride a different axis)* ✅
5. **Fail-closed:** under `strictScope`, `forget({})` / a scope-less broad memory forget **throws**. ✅
6. **Back-compat:** `forget('exact-id')` works under strict (precise form exempt). ✅
7. **Footgun:** `scoped(A).forget({ by })` throws (scope+by rejected, not a silent full-tenant wipe). ✅
8. **Failability:** a non-strict ownerless instance's `forget({kind})` wipes BOTH tenants (proves the asserts can fail). ✅

---

## 5. Tenant model (consistent with the isolation ask — single-dim)

`scope` (tenant string) → `mem_scope.owner`; `session` untouched. A customer ≡ one chat, so owner alone fences both kinds; the owner/admin tier crosses chats for free (facts are session-blind). forget fences on `owner` only.

---

## 6. Non-goals (all preserved in the delivery)

- **Not** a `reset()`/wipe-all — the empty-selector guard stays; a scope-less memory forget under `strictScope` throws; `reset()` remains the only "delete everything".
- **Not** doc/blob deletion — the `fact`/`episode` axis only; doc scoping (`doc_scope.scope`) stays separate.
- **Not** stash eviction — `evict` owns the stash table; `forget` never reaches it.

---

## 7. multis status — DELIVERED, wired, validated

- `context.forgetMemory(scope)` → `ctx.scoped(scope).forget()` (`src/context/index.js`); 2 integration cases (tenant-fenced clear + fail-closed no-scope throw) green.
- Validated against the **published** 0.22.0 artifact (`/tmp/m4-poc/validate-0220-forget.mjs`, 16/16, failable); suite **531/531**, audit 0.
- Remaining: increment 2 wires `/forget` (handlers) onto `context.forgetMemory` + removes the old fs-backed `clearMemory`; increment 3 removes the rest of `src/memory/*`.
