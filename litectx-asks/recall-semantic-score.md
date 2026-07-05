# litectx ask — surface the semantic (KNN cosine) score on recall hits

**Filed:** 2026-07-05 · **Module:** M13 (supersede pre-check) · **Priority:** 🟢 LOW (optimization — multis ships M13 without it)
**Found against:** installed litectx **0.25.0** (= npm latest, current dep)
**Status:** OPEN — filed as a written ask per the customer contract (libs grow, multis never papers over). multis ships M13 on a multis-side workaround meanwhile; this ask would let the workaround be deleted.

## Need

M13 adds a cheap **pre-check** in front of the `/remember` supersession LLM judge: before asking the model "does this note UPDATE an existing fact or is it NEW?", multis checks the **semantic cosine** between the new note and the most-similar existing fact. If nothing is close (below a conservative threshold), the note is definitely a new subject → **skip the LLM entirely**. (Broad POC, 30 facts / 40 notes, installed 0.25.0 embedder: restatements 0.44–0.86, unrelated 0.06–0.44, bulk cleanly separated; a 0.30 floor skips ~67% of unrelated saves with zero false-skips, ~2ms vs a full LLM round-trip.)

The cosine multis needs is **the exact value litectx already computes** during a semantic `recall`: to rank KNN hits, litectx embeds the query and cosines it against stored vectors. But that value isn't surfaced — the only score on a hit is `hit.score`, which in blended mode is **BM25-dominated**: for a paraphrased restatement that shares no lexical tokens (`"I now weigh 78kg"` vs `"my weight is 80kg"`; `"electrician"` vs `"plumber"`) `hit.score` is **`0.0`**, identical to an unrelated note — even though the KNN *ranking* correctly places the right fact first. So `hit.score` cannot gate the pre-check.

**Today's multis-side workaround (what this ask would retire):** multis re-embeds the note **and each candidate fact** with the exported `Embedder`, then calls the exported `cosine` itself — recomputing vectors litectx already had. Correct and cheap (~2ms/candidate), but redundant work on litectx's own index.

## Preferred shape *(litectx owns the final API — Principle 8)*

In embeddings mode, expose the **per-hit semantic cosine** on `recall` results — the KNN similarity litectx already computed for ranking — as a distinct field, e.g.:

```js
const hits = await view.recall(note, { kind: 'fact', n: 5, body: true });
// each hit: { path, body, score /* blended, unchanged */, cosine /* NEW: raw semantic sim in [-1,1] */ }
```

`cosine` present only when embeddings are on (absent/`null` in BM25-only mode — multis already treats "no semantic score" as "pre-check inert, run the judge"). Any equivalent surface works — a `semanticScore` field, or a `{ withScores: true }` recall option — as long as a consumer can read the query↔hit cosine **without re-embedding**. Not asking to change `score`'s meaning (back-compat).

## Failable acceptance

1. Semantic recall of a **paraphrased** restatement (no shared tokens, e.g. `"I now weigh 78kg"` vs a stored `"my weight is 80kg"`) returns a top hit whose surfaced `cosine` is **high** (≳0.5) — where `hit.score` today is `0.0`. (Proves the semantic value, not BM25, is exposed.)
2. Recall of an **unrelated** note returns a top-hit `cosine` that is **low** (≲0.35) — so a fixed threshold separates the two classes (the whole basis of the pre-check).
3. In **BM25-only** mode the field is absent/`null` (no embedder loaded) — no crash, no surprise value.
4. The value matches an independent `cosine(embed(query), embed(hit.body))` to within float tolerance — i.e. it IS the semantic similarity, not a re-normalized blend.

## Not blocking

multis ships M13 now on the re-embed workaround; the pre-check is fully functional without this. When litectx surfaces the score, multis deletes the re-embed loop in `src/context/index.js` (`factCandidates`) and gates directly on `hit.cosine` — dropping the pre-check's added cost to **zero** (gate on a value the recall already produced). File-and-wait, not a blocker.
