# litectx PRD — Memory-axis: surface semantic score on recall + scoped delete-by-id

**Filed:** 2026-07-05 · **Consumer:** multis (M13 supersede pre-check, M14 targeted `/forget`)
**Found against:** installed litectx **0.25.0** (multis dep at filing)
**Target:** litectx **0.27.0** (0.26.x already shipped `enumerate`; both features here are additive — no breaking change) — *litectx retargeted after source-level validation, 2026-07-05.*
**Priority:** 🟢 LOW — multis ships both consumer features TODAY on documented workarounds; this PRD lets multis delete the workarounds. **Neither blocks a multis release.**

> **litectx source-validation verdict (2026-07-05):** both VALID at source level; neither is POC-shaped (correctness-only mechanisms, no new empirical claim to falsify). Feature A: cosine is genuinely computed-and-discarded (`store.js:1757` knn ranking; `index.js:641` `_rankKind` blend) → surfaced as a **raw, unblessed** value with **no threshold/quality label** (see posture note below). Feature B: mirrors W4's `memKey(owner,id)` fence exactly — the stronger structural fix. Field name agreed as **`cosine`** (not `semanticScore`, which re-overloads the BM25 `score`).

> Consolidates two previously-filed asks — `recall-semantic-score.md` (M13) and `scoped-forget-by-id.md` (M14) — into one developer-ready spec. litectx owns the final API surface (Principle 8); the shapes below are the need, not a mandate. Line references (`src/index.js:NNN`) are as observed in 0.25.0 — verify against current source.

---

## Background — why these two, together

Both gaps surfaced building **memory-axis** consumer features on top of litectx's `scoped()` view. They're independent (ship either alone) but touch the same `recall`/`forget` memory surface, so they're specced together.

- **Feature A** (recall score) is a *read* gap: litectx computes a value internally (KNN cosine) that it doesn't return, forcing the consumer to recompute it.
- **Feature B** (scoped delete-by-id) is a *write* gap: the two existing delete paths don't compose into the "delete THIS tenant's row by id" a multi-tenant consumer needs.

Neither changes existing behavior; both are strictly additive.

---

## Feature A — surface the semantic (KNN cosine) score on recall hits

### Problem

A semantic `recall` embeds the query and cosines it against stored vectors to rank KNN hits. That cosine is **computed but not surfaced**. The only score on a hit is `hit.score`, which in blended mode is **BM25-dominated**: for a paraphrased restatement that shares no lexical tokens, `hit.score` is `0.0` — *identical to an unrelated note* — even though KNN *ranking* correctly placed the right row first.

Measured against the installed 0.25.0 embedder (multis POC, 30 facts / 40 notes):

| Note class | `hit.score` (BM25/blended) | true KNN cosine |
|---|---|---|
| Paraphrased restatement (`"I now weigh 78kg"` vs stored `"my weight is 80kg"`) | **0.0** | **0.44–0.86** |
| Unrelated note | 0.0 | 0.06–0.44 |

So `hit.score` **cannot** distinguish a semantic near-duplicate from an unrelated note. The cosine can (bulk cleanly separated; a 0.30 floor skipped ~67% of unrelated saves with zero false-skips in the POC).

### Consumer use case (M13)

multis puts a cheap **pre-check** in front of an LLM supersession judge on `/remember`: if the new note's cosine to the most-similar existing fact is below a conservative threshold, the note is definitely a new subject → skip the LLM entirely (~2ms vs a full round-trip).

### Current workaround (what this retires)

multis re-embeds the note **and each candidate** with the exported `Embedder`, then calls the exported `cosine` itself — recomputing vectors litectx already produced during the same `recall`.

### Desired API shape

In embeddings mode, expose the **per-hit semantic cosine** — the KNN similarity litectx already computed for ranking — as a distinct field on recall hits:

```js
const hits = await view.recall(note, { kind: 'fact', n: 5, body: true });
// each hit gains:  cosine: <raw semantic sim in [-1, 1]>   // NEW
//   score stays exactly as-is (blended/BM25) — meaning unchanged, back-compat
```

Field name **`cosine`** (agreed — `semanticScore` would re-overload the BM25 `score`). Surface it **raw and unblessed**, present per-hit by default in embeddings mode — as long as a consumer reads the **query↔hit cosine without re-embedding**.

> **Posture (litectx doctrine — "surface the column, never a quality label"):** litectx exposes the raw cosine and does **NOT** claim a threshold cleanly separates "related" from "unrelated." The measured bands **overlap** (paraphrase 0.44–0.86, unrelated 0.06–0.44 — touching at ~0.44): top-cosine separates in *aggregate* (good AUC) but has **no usable per-query threshold**. **The consumer (multis) owns the threshold and its false-skip risk.** multis accepts this: M13's cut is 0.30 — *below* the paraphrase floor — so its one-sided gate only ever skips an *unrelated* save (worst case: a wasted judge call), never a real supersession. A consumer that picked a cut ≥0.44 could wrongly skip a paraphrase; that's the consumer's call, not litectx's guarantee.

### Acceptance criteria (failable)

1. Semantic recall of a **paraphrased** restatement (no shared tokens, e.g. `"I now weigh 78kg"` vs stored `"my weight is 80kg"`) returns a top hit whose surfaced `cosine` is **materially positive** where `hit.score` today is `0.0`. *(Proves the surfaced value is the semantic similarity, not BM25 — the load-bearing check.)*
2. For a **single** query, an **unrelated** note's `cosine` is **lower** than the paraphrase's — a *relative* ordering only. **No cross-query fixed-threshold claim** is asserted (the bands overlap across queries; litectx surfaces the raw value, the consumer sets any cut).
3. In **BM25-only** mode (no embedder loaded / no qvec path) the field is **absent/`null`** — no crash, no surprise value. *(Satisfied by construction — the no-qvec path never computes a cosine.)*
4. The surfaced value matches an independent `cosine(embed(query), embed(hit.body))` to within float tolerance — i.e. it IS the raw semantic similarity, not a re-normalized/min-max blend. *(litectx attaches the pre-min-max value, covering the `cand.length < 2` early-return uniformly.)*

### Non-goals / constraints
- Do **not** change the meaning of `score` (back-compat — multis and others gate on it as-is).
- Do **not** bless a separating threshold in docs — surface the raw `cosine` only; the consumer owns the cut.
- No new required option — semantic mode should surface `cosine` by default; a `{ withScores }` opt-in is fine if perf demands it.

---

## Feature B — scoped delete-by-id on the memory axis

### Problem

Deleting **one** memory row by id, tenant-fenced, has no single call. The two paths don't compose:

- **`scoped(tenant).forget(sel)`** — tenant-fenced, but **rejects `{id}`/`{idPrefix}`/`{by}`** and throws on `{id}` (`src/index.js:844`). It deletes the whole tenant (optionally narrowed by `{kind}`).
- **base `ctx.forget({id})`** — deletes by exact id but is **owner-BLIND**: no scope/owner fence (`src/index.js:858` → `store.forgetMemory({id})`, no `owner`).

A multi-tenant consumer that wants "delete THIS tenant's row with THIS id" must bridge in policy: verify the id is in-scope via scoped `get(id)` (null cross-tenant), *then* call the owner-blind delete. Correct **only** if ids are globally unique across scopes — an invariant the lib doesn't enforce.

### Consumer use case (M14)

`/forget wedding` deletes the one matched note, not the whole scope — so it deletes **by id**. multis mints globally-unique ids (`mem-<ts>-<seq>`, promoted facts `fact-<uniqueEpisodeId>`), so the blind delete is safe today — but the safety leans on a lib-external invariant.

### Current workaround (what this retires)

```js
// multis src/context/index.js#forgetById
if (!view.get(id)) return 0;        // scoped-get verify: null cross-tenant → refuse
let removed = ctx().forget({ id }); // owner-BLIND delete, safe only under unique-id invariant
```

### Desired API shape

Let the **scoped** view delete by id, tenant-fenced — the `(scope, id)` delete that mirrors the `(scope, id)` **upsert** litectx already supports (W4, 0.24.0):

```js
ctx.scoped('user:B').forget({ id: 'mem-…' });   // deletes ONLY if that id belongs to user:B; else 0
```

i.e. `{id}` (and ideally `{idPrefix}`) **combine with the tenant fence** instead of throwing — internally `forgetMemory({ ownerFenced: true, owner, id })`. A row whose id lives under a *different* owner is not matched (returns 0), exactly like scoped `get`. An equivalent `scoped().forgetById(id)` is fine.

### Acceptance criteria (failable)

1. `scoped(A).forget({ id: X })` where X is A's row → removes **1**; A no longer has it.
2. `scoped(B).forget({ id: X })` where X belongs to **A** → removes **0**, A's row **survives** (the fence, not id-matching, decides). *This is the case the owner-blind delete gets wrong when two scopes share an id.*
3. `scoped(A).forget({ id: X, kind: 'fact' })` narrows as today; a missing scope still **throws** (fail-closed, unchanged).
4. Symmetry: the same `(scope, id)` that upserts under W4 also deletes here — round-trip.

### Non-goals / constraints
- Keep the existing whole-tenant `scoped().forget()` (no selector) behavior unchanged.
- Fail-closed on missing scope stays (strictScope) — don't loosen it to enable id-delete.

---

## Summary for the litectx developer

| | Feature A (read) | Feature B (write) |
|---|---|---|
| **Surface** | `recall` hits | `scoped().forget()` |
| **Change** | add `cosine` field (semantic mode only) | accept `{id}` under the tenant fence instead of throwing |
| **Breaking?** | No — additive field | No — was a throw, now a fenced delete |
| **Internal value already exists?** | Yes (KNN ranking cosine) | Partly (`forgetMemory` + owner fence exist separately) |
| **multis absorption** | delete the re-embed loop, gate on `hit.cosine` | swap owner-blind `ctx.forget({id})` → `view.forget({id})` |

Both are additive → a single **0.27.0** minor release. Ship either independently if one lands first.
