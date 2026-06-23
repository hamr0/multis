# litectx ask — chunk plain-text files (`.txt`/`.text`/`.log`/`.csv`) into recallable rows

**From:** multis (first baresuite customer), module **M3** (surfaced during the M9 LIVE‡ SEC2 pass).
**Against:** litectx **0.18.0** (installed npm artifact; behaviour proven below against `src/context`, not asserted).
**Date:** 2026-06-21.
**Severity:** LOW–MEDIUM — a silent-no-op data gap, not a correctness or security hole. A plain-text
upload is accepted and reports success but is never searchable. No leak, no crash.
**Status:** FILED — multis advertises `txt` as a supported type today; rather than bolt a plaintext
chunker into the thin wrapper (forbidden by the storage-on-litectx contract), this records the gap.

---

## Finding

litectx ingests and chunks **`.md`** (and, since 0.17.0, **PDF/DOCX → md**). Plain-text family
files are ingested without error but produce **0 chunks** and are **not recallable**. Proven against
the installed 0.18.0 via multis's production path (`src/context/indexBuffer` → `view.ingest`):

```
md   → 1 chunk   recall("zonkberry") → ['doc:a#0']   ✅ searchable
txt  → 0 chunks  (not in recall results)             ❌
text → 0 chunks                                       ❌
log  → 0 chunks                                       ❌
csv  → 0 chunks                                       ❌
```

(Each file held the same unique term; only the `.md` row came back.) The bytes appear to be stored
as an unparsed blob (per litectx's own docs: *"a blob … is NOT parsed … only the `maxSize` cap"*),
so there is no markdown chunker dispatched for a plaintext extension/MIME.

## Why it matters to multis

`config.documents.allowedTypes` ships `["pdf","docx","txt","md"]` — `txt` is **advertised as
supported**. A user who drops a `.txt` (or a `.log`/`.csv`) in chat, or runs `/index notes.txt`,
gets an "indexed" acknowledgement with a chunk count that can be **0**, and the content is then
invisible to every RAG recall. The failure is silent: no error, no warning, just empty results
later. Plain text and CSV are among the most common things a non-technical user will hand a bot.

## What multis did in the meantime

Nothing in the wrapper (no local plaintext parser — that would re-implement storage inside multis,
which Principle 1/8 forbid). The SEC2 bounds tests use `.md`/PDF fixtures, and this finding is noted
in-test. Options multis will take depending on the resolution:
- if litectx adds a plaintext chunker → drop nothing, it just works;
- if litectx declines → multis narrows `allowedTypes` to the actually-chunked set and/or surfaces a
  clear "stored but not searchable" message on a 0-chunk ingest, so the no-op stops being silent.

## The ask

Treat plain-text family files as first-class chunked `kind:doc` input — the content is *already*
markdown-compatible flat text, so it should reuse the **existing md chunker** (no new format-native
chunker, matching the PDF/DOCX→md approach):

- **`.txt` / `.text`** → feed straight to the md chunker (it's plain prose already).
- **`.log`** → same (line-oriented prose); chunking by size is fine.
- **`.csv`** → at minimum chunk the raw text so rows are searchable (a structured/columnar parse is
  a nice-to-have, not required).

Detection by extension and/or MIME, consistent with how md/pdf/docx are dispatched today.

**Acceptance:** ingesting a non-empty `.txt`/`.log`/`.csv` returns `chunks >= 1` and the content is
returned by `recall(term, {scope})` for a term in the body — same as `.md` does now. If a format is
deliberately stored-as-blob-only, `ingest` should signal that (a flag or a distinct return) so the
host can tell "indexed + searchable" from "stored, not searchable" instead of inferring it from a
silent `0`.

## Out of scope / non-asks

- The `maxSize`/`maxPages` bounds, scope fence, and md/PDF/DOCX chunking are all delivered and
  validated through the wrapper (`test/integration/context.test.js`, green against 0.18.0). This ask
  is only the **plaintext chunking gap**.
- Not blocking: M3/M9 ship without it; the common doc types (md, PDF, DOCX) work. This is a
  coverage-completeness + silent-no-op item.

---

## Clarifications (resolved 2026-06-23)

litectx came back with three clarifying questions against 0.18.0 source. multis's answers, decided
from what the RAG consumer actually needs (not the literal wording above):

**Q1 — "reuse the md chunker" → use the size-budget paragraph packer instead.**
The md chunker splits on `#` headings and returns the *whole file as one chunk* when there are none
(`chunker.js:205`: `if (!heads.length) return [fileChunk(body)]`). Generic `.txt` prose, `.log`, and
`.csv` have no markdown headings → one giant unbounded row, which defeats RAG recall granularity and
bloats the FTS row / prompt injection. "Reuse the md chunker" in the ask was shorthand for *reuse
shipped machinery, no new format-native chunker* — and the ask already conceded "chunking by size is
fine" (`.log`) and "a structured parse is not required" (`.csv`). **Decision: route plain-text family
files through the existing size-budget paragraph packer (the PDF path minus pdfjs) — split on blank
lines where present, size-pack otherwise.** Strictly better for multis, still honors "no new
format-native chunker."

**Q2 — the "signal blob-only instead of a silent 0" clause is already satisfied → withdrawn.**
`ingest()` already returns `{ mode: "chunked" | "blob", chunks }`; `mode` is exactly the
searchable-vs-stored signal this clause asked for. No new flag needed from litectx. **The action
moves to the multis side:** surface `mode`/`chunks` in the `/index` reply rather than infer from a
bare `0`. (Tracked as a multis follow-up — the host-path `/index` reports bare success today.)
**Consider this clause withdrawn from the ask.**

**Q3 — extension-only dispatch + the exact set. Confirmed.**
Extension-only is fine — multis always passes the original filename to `indexBuffer` (we already do,
because Beeper strips extensions on download), and the `format:"txt"` override covers the rare
no-filename path. No MIME sniffing — multis respects litectx's extension-only doctrine. **Lock the
set to exactly `.txt`, `.text`, `.log`, `.csv`** — an explicit allowlist, not an open "texty things
are chunkable." multis does not need `.tsv`/`.json`/`.yaml`/`.ini` today; a follow-up will be filed
if that changes.

**On litectx's two notes (accepted, not questions):**
- No new parser / optional peer dep / parser-CVE surface for plain text — correct, that's why it's
  the easy case.
- Routing plain text through `remember` → writeGate is the *intended* consequence: plain text can now
  reach an LLM via RAG, so it should be screenable. multis's writeGate is a later module (M7); until
  it's wired, plain text is unscreened like the rest of multis's ingest. No objection.

**Net:** the ask is build-ready with one design change (size-packer, not the literal md chunker) and
one clause withdrawn (Q2). Acceptance is otherwise unchanged: a non-empty `.txt`/`.text`/`.log`/`.csv`
returns `chunks >= 1` and the body term is returned by `recall(term, {scope})`.
