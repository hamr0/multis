# litectx ask — scoped delete-by-id on the memory axis

**Filed:** 2026-07-05 · **Module:** M14 (targeted `/forget`) · **Priority:** 🟢 LOW (defense-in-depth — multis is safe today via an id-uniqueness invariant)
**Found against:** installed litectx **0.25.0** (= npm latest, current dep)
**Status:** OPEN — filed per the customer contract (a lib gap surfaced by a consumer feature). multis ships M14 relying on globally-unique ids; this ask would remove that reliance.

## Need

M14 adds a **targeted** forget: `/forget wedding` removes the one matched note, not the whole scope. To delete a single memory row, multis must delete **by id**. Today the two litectx delete paths don't compose the way a multi-tenant consumer needs:

- **`scoped(tenant).forget(sel)`** is tenant-fenced but **rejects `{id}`/`{idPrefix}`/`{by}`** — it deletes the whole tenant (optionally narrowed by `{kind}`) and explicitly throws on `{id}` (`src/index.js:844`).
- **base `ctx.forget({id})`** deletes by exact id but is **owner-BLIND** — no scope/owner fence (`src/index.js:858` → `store.forgetMemory({id})`, no `owner`).

So a consumer that wants "delete THIS tenant's row with THIS id" has no single fenced call. multis bridges it in policy: it (a) verifies the id is in-scope via the scoped `get(id)` (null cross-tenant — so a caller can never *target* a foreign id), then (b) calls the owner-blind `ctx.forget({id})`. This is safe **only because multis mints globally-unique ids** (`mem-<ts>-<seq>`; promoted facts `fact-<uniqueEpisodeId>`; W4 reuses an existing unique id) → no two scopes ever share an id, so the blind delete can match only the verified row. Correct today, but it leans on an invariant the lib doesn't enforce.

## Preferred shape *(litectx owns the final API — Principle 8)*

Let the **scoped** view delete by id, tenant-fenced — the (scope, id) delete that mirrors the (scope, id) **upsert** litectx already supports (W4, 0.24.0):

```js
ctx.scoped('user:B').forget({ id: 'mem-…' });   // deletes ONLY if that id belongs to user:B; else 0
```

i.e. `{id}` (and ideally `{idPrefix}`) **combine with the tenant fence** instead of throwing — `forgetMemory({ ownerFenced: true, owner, id })`. A row whose id exists under a *different* owner is not matched (returns 0), exactly like the scoped `get`. Any equivalent surface is fine (a `scoped().forgetById(id)`), as long as the delete is fenced to the bound tenant.

## Failable acceptance

1. `scoped(A).forget({id: X})` where X is A's row → removes 1; A no longer has it.
2. `scoped(B).forget({id: X})` where X belongs to **A** → removes **0**, A's row **survives** (the fence, not id-matching, decides). This is the case the base owner-blind delete gets wrong when two scopes share an id.
3. `scoped(A).forget({id: X, kind:'fact'})` narrows as today; a missing scope still throws (fail-closed).
4. Symmetry check: the same (scope, id) that upserts under W4 also deletes here — round-trip.

## Not blocking

multis ships M14 now (scoped-`get` verify + owner-blind delete, safe under unique ids). When litectx fences delete-by-id, multis swaps `ctx.forget({id})` → `scoped(scope).forget({id})` in `src/context/index.js#forgetById` and drops the reliance on the uniqueness invariant. File-and-wait, not a blocker.
