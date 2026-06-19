# litectx ask — fail-closed recall scope for multi-tenant stores (`null` ≠ "all")

**From:** multis (first baresuite customer), module **M3** (security pass).
**Against:** litectx **0.17.1** (installed npm artifact; behaviour read from source, line-cited below — not asserted).
**Date:** 2026-06-18.
**Severity:** HIGH — a tenant-isolation footgun. Not a bug in litectx's *single-tenant* contract, but the
default it inherited from that contract is unsafe for the multi-tenant doc store R2 was added to serve.
**Status:** **DELIVERED in litectx 0.18.0 + VALIDATED + CONSUMED.**
litectx 0.18.0 shipped all three pieces exactly as refined: `strictScope` (read *and* write throw on a
missing scope), `GLOBAL` (an exported `Symbol`, sentinel-not-stored → `doc_scope.scope IS NULL`, no
migration), `ctx.scoped(scope)` (auto-fenced view, throws on a bad bind); doc/blob axis only —
`fact`/`episode`/`code` untouched; default off → back-compat preserved. **Validated against the
installed 0.18.0** by a failability-proven throwaway POC (16/16): a *set* scope returns `scope ∪
GLOBAL` and never another tenant; a missing scope throws on `recall`/`get`/`ingest`/`scoped()`; `GLOBAL`
recall returns the KB only; `scoped()` auto-fences read+write — and a **non-strict control instance
still leaks** on a missing scope, proving the strict assertions can fail. **Consumed:** `src/context`
now runs on native `strictScope` + `ctx.scoped()` — the hand-rolled `toRecallScope` throw is gone, one
`toScope` vocab map remains, and every wrapper op (read *and* write) goes through a scope-bound
`scoped()` handle (the KB write is `scoped(GLOBAL)`). Full suite 420/0 green on the consumption.

---

## Finding

`recall({ scope })` on the **doc** axis is **fail-open**: an omitted/`null` scope returns **every
tenant's rows**, not "nothing" and not "the global tier." In a store that holds scoped data, a single
forgotten scope leaks all of it.

Grounded in the installed 0.17.1 source:

- `recall` defaults a missing scope to `null`:
  `const filter = { scope: opts.scope ?? null, now: Date.now() };` — `src/index.js:349`.
- The doc-recall SQL treats `null` scope as **no filter**:
  `AND (:scope IS NULL OR ds.scope IS NULL OR ds.scope = :scope)` — `src/store.js:1103`.
  `:scope IS NULL` short-circuits the whole predicate → admin + every `user:*` + global all return.
- This is documented as deliberate **back-compat** with litectx's pre-scope origin:
  *"Default null = unscoped (global / durable) → recall sees everything … byte-identical to the
  pre-scope behavior."* — `src/store.js:158-160`.

That default is correct for litectx's home turf (one repo, one developer, no tenants). It is the wrong
default the moment a store carries scopes — which is exactly what R2 was built for. `null` is
**overloaded** across three distinct intents that should never share a value:

| intent | today's spelling | what it should mean |
|--------|------------------|---------------------|
| write to the **shared/global tier** (the KB) | `scope: null` at ingest | explicit "global" |
| **read everything** (single-tenant / admin tooling) | `scope: null` at recall | explicit "all", opt-in |
| **forgot to pass a scope** (a bug) | `scope` omitted → `null` | error, never "all" |

The third collapsing into the second is the vulnerability: a missing scope is indistinguishable from
"deliberately read all," so the leak is silent.

### The tell: litectx already does this safely — for *memory*

litectx has two scope axes, and they disagree on where scope is bound:

| axis | scope set… | recall fence | forgettable? |
|------|-----------|--------------|--------------|
| **memory** (`fact`/`episode`) | once, on the **Store instance** (`owner`/`session`) — `src/store.js:248-252` | `(:me IS NULL OR s.owner IS NULL OR s.owner = :me)`, `:me = this.owner` — `src/store.js:1083` | **no** — there is no per-call scope to forget |
| **doc** (R2 — what multis uses) | **per-call**, at ingest *and* recall | `(:scope IS NULL OR …)`, `:scope = filter.scope` — `src/store.js:1103` | **yes** |

The memory axis is safe *because the reader declares identity once, structurally*. The doc axis made
scope a per-call argument, and that single design choice is the whole exposure. The inconsistency
between the two axes is the smell.

## What multis did in the meantime

Per the no-papering-over contract, multis closed this at its **own** boundary, not by reaching into
litectx's store:

1. **Fail-closed translator** (`src/context/index.js` `toRecallScope`): `search`/`searchMemory` throw
   if scope is missing or is a write-only tier (`'public'`/`'kb'`, which map to `null` = all on read).
   A forgotten scope is now a loud dev-time error, not a prod leak.
2. **(Planned) scope-bound handle** (`context.forScope(scope)`): binds scope once and exposes
   `search`/`searchMemory`/`indexBuffer` with no scope parameter — making "forgot to pass scope" a
   non-existent code path at the multis API, mirroring litectx's own memory-axis model.

These make multis safe regardless of litectx, but they are a per-consumer reimplementation of a fence
that belongs in the lib — every future litectx multi-tenant consumer would have to rediscover it.

## The ask

Make a multi-tenant litectx store **fail closed by default**, and stop overloading `null`. This is
**not a menu** — (a) and (c) do *different* jobs and multis needs both; (b) is the sentinel (a)
requires:

- **(a) `strictScope` flag — closes the literal hole on the BASE path.** Load-bearing for the
  *security property*: with it on, the bare `recall`/`get`/`ingest`/`remember` throw on a missing
  scope. The view (c) alone is only safe-*by-convention* — the base `recall()` still fails open right
  beside it, one forgetful call away. The flag is what makes the base path itself safe.
- **(c) `scoped(scope)` view — makes forgetting a NON-EXISTENT code path.** Load-bearing for
  *ergonomics*: a handle with no per-call scope param can't be called wrong. This is the keystone for
  a consumer like multis, but it must not *stand in for* (a) — ship both.
- **(b) `GLOBAL` sentinel — the opt-in (a) needs.** Once `null`/omitted means *deny* (not *all*),
  there must be an explicit way to say "the shared tier" for both reading and writing the KB.

```js
// (a) strict mode — DISTINCT config key (do NOT reuse `scope`, which is a tenant-id
//     string everywhere else; overloading it is the same disease this ask cures).
//     Defaults off → single-tenant callers untouched (back-compat preserved).
new LiteCtx({ root, dbPath, strictScope: true })  // or { multiTenant: true }

// under strictScope, a missing scope THROWS on BOTH axes — read AND write:
ctx.recall(q, { kind: 'doc' })                    // throws (was: every tenant)
ctx.get(id)                                       // throws (was: scope-bypass)
ctx.ingest(bytes, { filename })                   // throws (was: silent write to global KB)

// (b) GLOBAL is how you explicitly opt into the shared tier, on read OR write:
ctx.recall(q, { kind: 'doc', scope: GLOBAL })     // only the shared KB
ctx.ingest(bytes, { filename, scope: GLOBAL })    // deliberately publish to the KB

// (c) scope-bound view — fences the DOC axis the way the instance owner already
//     fences the MEMORY axis; no per-call scope param to forget, on read or write.
const view = ctx.scoped('user:42')                // or 'admin', or GLOBAL
await view.recall(q, { kind: 'doc' })             // auto-fenced: scope ∪ global, always
await view.ingest(bytes, { filename })            // writes bound to the same scope
```

### The write side throws too (not just read)

The original framing only fenced recall/get. That's incomplete in the same way the R2 `get`-fence was:
an omitted scope at **`ingest`/`remember`** on a multi-tenant store silently writes to the **global
tier** — a *persistent* cross-tenant disclosure, arguably worse than a read leak because it outlives
the call. Under `strictScope`, the write path must throw on a missing scope too: **you must say
`GLOBAL` to write the KB.** The `scoped()` handle (c) covers this for view users; the flag (a) must
cover it for the base path. Finishing the requirement is correct, not scope creep.

Constraints that matter to multis:

- **Back-compat:** single-tenant callers (litectx's core audience) keep today's behaviour when
  `strictScope` is off. Opt-in safety upgrade, not a breaking default flip — unless you decide the
  default *should* flip, which multis would welcome.
- **`scope ∪ null-global` semantics unchanged** for a *set* scope (own + shared KB; never another
  tenant) — only the *missing/`null`* case changes from "all" to "deny / explicit-`GLOBAL`".
- **Same fence on `get()`** — the R2 handle fence (`get(id, {scope})`) shares the strict rule (missing
  scope on a strict store → deny, not bypass).
- **Symmetry across axes:** the doc axis gains an instance/view binding (c) so it stops being the odd
  one out vs `fact`/`episode`.

### Implementation guards (litectx's lane — pinned to avoid re-litigation)

- **`GLOBAL` is a read/write SENTINEL, never a stored value.** It maps to `WHERE ds.scope IS NULL` on
  read and to "write no `doc_scope` row" (i.e. `scope IS NULL`) on write — keeping global rows exactly
  as they are today. This is additive, needs **no migration**, and leaves the existing `scope ∪ NULL`
  union logic untouched. Implementing `GLOBAL` as a stored marker (e.g. `'*'`) would buy a migration
  and break the union — don't.
- **Distinct config key, not `scope:'strict'`.** `scope` is a tenant-id string on every other API;
  making it *sometimes* a mode string reintroduces the exact overload this ask exists to cure. Use
  `strictScope: true` (or `multiTenant: true`).

## Out of scope / non-asks

- The R2 fence itself is correct and delivered — a *set* scope returns `scope ∪ null-global` with no
  cross-tenant leak (validated green in `test/integration/context.test.js` against 0.17.1). This ask is
  only about the **default when scope is absent**, and the `null`-means-many-things overload.
- **Do NOT make the MEMORY axis fail-closed under `strictScope`.** `owner: null` should still see all
  owners — multis doesn't use the memory axis for tenancy, and the symmetry point (c) is about giving
  the *doc* axis a binding, not flipping memory's default. Leave the `fact`/`episode` behaviour exactly
  as it is; `strictScope` governs the doc/blob axis only.
- Not asking litectx to know multis's scope vocabulary (`admin`/`user:<chatId>`/`kb`) — that mapping
  stays in multis's wrapper. The ask is purely the fail-closed default + the `GLOBAL` sentinel (+ the
  scoped view).
- **Not blocking M3.** multis is already fail-closed at its wrapper, so the security gate is met today;
  this is the upstream durability fix so the next multi-tenant consumer inherits safety instead of a
  footgun. Natural to land alongside the M4 memory-policy work.
