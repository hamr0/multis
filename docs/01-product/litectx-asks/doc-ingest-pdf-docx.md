# litectx ask — document ingest: PDF/DOCX → markdown, chunked + indexed

**From:** multis (first baresuite customer), migration module **M3** (replace `src/indexer/*` with litectx).
**Against:** litectx **0.16.2** (installed npm artifact; findings proven, not asserted).
**Date:** 2026-06-18.
**Status:** FILED — M3 is blocked on this (Principle 4: the wait is the validation).
**Decision behind it:** litectx owns the PDF/DOCX→md parser and the ingest. multis does **not** keep a parallel parser path (§D). This is the §D-ideal placement, chosen by the multis owner after a POC + design discussion.

---

## 1. The use case (what multis needs to do)

A user (the owner, or a customer in business mode) **drops a PDF or DOCX into a chat**. multis receives that document as an **in-memory `Buffer`** (via beeperbox's `download_asset` verb) together with the original filename. multis must hand the bytes to litectx and have them **ingested as recallable `doc`-kind content**, so that a later `recall(query, { kind: 'doc' })` surfaces the document's text. This is the headline "query your documents" capability of the product; PDF is the dominant real-world format (statements, manuals, papers, scanned letters), DOCX secondary.

The source is a **transient uploaded buffer**, not a file living in a git/disk repo root.

## 2. What litectx does today (0.16.2, verified)

- `index({ paths, force })` sweeps a **disk/git root**, filtered by extension (default `ts/js/py/md`), reading each file as **`utf8`**.
- A PDF placed in that root indexes as **binary garbage** — verified: a real `sample.pdf` came back with `body` = `"%PDF-1.7 %äüöß 2 0 obj <</Length 3 0 R/Filter/FlateDecode>>…"`.
- `remember(id, text, { kind: 'doc' })` stores text **verbatim as a single unit** — no chunking; not the document-ingest path.
- There is **no buffer/content ingest entry point** and **no PDF/DOCX parser**.

This matches litectx's own roadmap: `litectx-memory-prd.md` records *"PDF/DOCX deferred"* and reserves `pdf`/`docx` as a **`format` field under `kind=doc`** ("never a new top-level kind"). This ask is to **build that reserved capability**.

## 3. The ask — two coupled capabilities

### 3.1 PDF/DOCX → markdown, then reuse the existing md chunker

Convert the document to **markdown**, then chunk it with litectx's **existing markdown chunker**. **Do not build a format-native (PDF-native) chunker** — convert to md and reuse the clean path. This is the architectural crux of the whole ask and it matches the reserved "format field under `kind=doc`" design: a PDF/DOCX is just a *lossy source of markdown*, not a new kind.

- **DOCX → md is clean and structured.** `mammoth.convertToMarkdown` extracts headings/lists/emphasis faithfully (multis already depends on mammoth; it currently calls `convertToHtml`, but `convertToMarkdown` is purpose-built for this).
- **PDF → md is lossy by nature.** PDF is a *presentation* format; realistic output is **flat text wrapped as markdown** — reading order is best-effort, columns/tables degrade, and scanned PDFs would need OCR (explicitly out of scope). Set the quality bar honestly at **"good-enough searchable text,"** not structural fidelity. (multis uses `pdfjs-dist` `getTextContent()` for this.)
- Resulting rows: `kind = "doc"`, `format = "pdf" | "docx"` (the reserved format field). Recall ranks them alongside `md` docs with no schema migration.

### 3.2 A single-document content-ingest entry point (buffer or path)

Because the source is an uploaded `Buffer` + filename (not a repo-root file), litectx needs an ingest entry **distinct from both `index()` (sweeps a root) and `remember()` (stores verbatim, unchunked)**: take the document's bytes (or a path to one file) + a format/filename hint, **convert → chunk → store** it, and make it recallable.

Proposed shape (**litectx's call** — this is the need, not a mandated API):

```js
// preferred: bytes-in, for the chat-upload flow
await ctx.ingestDocument(buffer, {
  filename: "acme-manual.pdf",   // drives format detection
  format:   "pdf",               // optional explicit override
  id:       "doc:acme-manual",   // optional stable id (else derived)
  meta:     { /* opaque passthrough, e.g. source chat */ },
});
// → { id, kind:'doc', format:'pdf', chunks: <n>, … }
```

The **buffer path is strongly preferred** over "materialize the upload into litectx's git root and call `index()`": chat uploads are transient, and maintaining a tracked on-disk tree of customer files imposes its own retention/cleanup/privacy burden on the integrator. If litectx prefers a path-based API, multis can write to a temp file — but a bytes entry is the clean fit.

(If litectx instead chooses to teach `index()` to convert `.pdf`/`.docx` files it encounters in the root, that also satisfies 3.1, but **3.2's buffer entry is the part that unblocks multis's chat-upload flow** and should not be dropped.)

## 4. Bounds — make these acceptance criteria (multis learned them the hard way)

Documents are **untrusted input**. The parser must bound it:

- **Size cap, page cap, parse wall-clock timeout** — configurable. A malicious/oversized PDF is a decompression-bomb / OOM vector. (multis enforces `maxSize` 10 MB, `maxPdfPages` 2000, `parseTimeoutMs` 30 s today; litectx should own equivalents.)
- **Graceful failure** — a corrupt/encrypted/unparseable document returns a **clear error**, never crashes the ingest pass and never pollutes the index with garbage.
- **Test fixtures** — hand-crafted minimal PDFs are *rejected* by some parsers (multis hit exactly this: `pdf-parse` refused them). Use **LibreOffice / real-tool-generated** fixtures in litectx's tests.

## 5. Dependency note (the weight litectx deferred)

This implies a PDF extractor (`pdfjs-dist`) + a DOCX converter (`mammoth`, which ships `convertToMarkdown`). These are the deps litectx deferred to stay light, and this ask explicitly requests taking them on. **Suggestion:** make the document-parser tier **optional/lazy**, mirroring litectx's existing embeddings tier (`@huggingface/transformers` as an opt-in peer dep) — consumers who never ingest PDF/DOCX shouldn't pay the install/load weight.

## 6. Boundary / framing (§D, §E)

- **litectx owns the whole document pipeline:** format detection → conversion to md → chunking (reuse the md chunker) → storage → ranking → recall.
- **multis owns only:** receiving the upload (transport, via beeperbox) and calling litectx's ingest with `(bytes, filename, scope, meta)`. **No parsing, no chunking, no parallel store** — `src/indexer/parsers.js` + chunker + store get deleted (the M3 goal).
- This is the §D-ideal: *"litectx ingests + chunks; multis keeps no parallel parser path."*

## 7. Acceptance criteria

1. A real **PDF** buffer ingested via the content entry → `recall(query, { kind: 'doc', body: true })` returns chunk(s) of **readable extracted text** (not `%PDF` bytes).
2. A real **DOCX** → same, with heading structure preserved in the md.
3. Resulting hits carry `format: "pdf" | "docx"` under `kind: "doc"`; no schema migration.
4. Oversized / over-page / slow / corrupt inputs are **bounded and fail gracefully** (clear error, index left intact).
5. multis can **delete `src/indexer/{parsers,chunker,chunk,store}.js`** and route both `/index` and chat-uploads entirely through litectx.

## 8. Out of scope for THIS ask — flagged, tracked separately

**Per-chat document isolation (§A).** multis's scope model wants `user:<chatId>` documents **fenced from other customers**. litectx's current invariant is *"code/doc are never scoped"* (global knowledge) — verified: with a shared DB, an `owner`-scoped `fact` isolates correctly, but a `doc` is visible to every owner. Convert-to-md does **not** change this. This is a **separate open question**, not part of this ask:

- multis will raise it as its own ask **if** per-customer private uploads prove to be a real requirement; or
- multis accepts **docs-as-global (kb only)** and models any per-customer private knowledge as `fact`/`episode` (which *are* owner-scoped) under M4.

Noted here only so the document-ingest design stays aware of the possibility (e.g., whether `owner`-scoping could ever extend to `doc`), not as a blocker on §3–§7.
