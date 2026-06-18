# litectx ask — fail-closed recall scope for multi-tenant stores (`null` ≠ "all")

**From:** multis (first baresuite customer), module **M3** (security pass).
**Against:** litectx **0.17.1** (installed npm artifact; behaviour read from source, line-cited below — not asserted).
**Date:** 2026-06-18.
**Severity:** HIGH — a tenant-isolation footgun. Not a bug in litectx's *single-tenant* contract, but the
default it inherited from that contract is unsafe for the multi-tenant doc store R2 was added to serve.
**Status:** FILED — multis closed the hole at its own wrapper boundary (fail-closed translator + a
scope-bound handle, below). This records the upstream design gap rather than treating the wrapper
patch as the whole fix.

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

Make a multi-tenant litectx store **fail closed by default**, and stop overloading `null`. Any of these
shapes (not exclusive — (a)+(c) is the ideal) works for multis:

```js
// (a) strict mode: an explicit opt-in that flips the unsafe default.
//     recall/get with a missing scope THROW (not "return all"); single-tenant
//     callers are untouched because the flag defaults off (back-compat preserved).
new LiteCtx({ root, dbPath, scope: 'strict' })   // or { multiTenant: true }

// (b) a distinct sentinel for "the shared/global tier" so it is never spelled
//     the same as "unspecified". null no longer means "all" on the read axis.
ctx.recall(q, { kind: 'doc', scope: GLOBAL })     // only the shared KB
ctx.recall(q, { kind: 'doc' })                    // strict mode → throws (was: every tenant)

// (c) a scope-bound view that fences the DOC axis the way the instance owner
//     already fences the MEMORY axis — no per-call scope param to forget.
const view = ctx.scoped('user:42')                // or 'admin'
await view.recall(q, { kind: 'doc' })             // auto-fenced: scope ∪ global, always
await view.ingest(bytes, { filename })            // writes bound to the same scope
```

Constraints that matter to multis:

- **Back-compat:** single-tenant callers (litectx's core audience) keep today's behaviour when the
  strict flag is off. The change is an opt-in safety upgrade, not a breaking default flip — unless you
  decide the default *should* flip, which multis would welcome.
- **`scope ∪ null-global` semantics unchanged** for a *set* scope (own + shared KB; never another
  tenant) — only the *missing/`null`* case changes from "all" to "deny / explicit-global".
- **Same fence on `get()`** — the R2 handle fence (`get(id, {scope})`) should share the strict-mode
  rule (missing scope on a scoped store → deny, not bypass).
- **Symmetry across axes:** ideally the doc axis gains an instance/view binding (c) so it stops being
  the odd one out vs `fact`/`episode`.

## Out of scope / non-asks

- The R2 fence itself is correct and delivered — a *set* scope returns `scope ∪ null-global` with no
  cross-tenant leak (validated green in `test/integration/context.test.js` against 0.17.1). This ask is
  only about the **default when scope is absent**, and the `null`-means-two-things overload.
- Not asking litectx to know multis's scope vocabulary (`admin`/`user:<chatId>`/`kb`) — that mapping
  stays in multis's wrapper. The ask is purely the fail-closed default + an unambiguous global sentinel
  (+ optional scoped view).
- **Not blocking M3.** multis is already fail-closed at its wrapper, so the security gate is met today;
  this is the upstream durability fix so the next multi-tenant consumer inherits safety instead of a
  footgun. Natural to land alongside the M4 memory-policy work.
