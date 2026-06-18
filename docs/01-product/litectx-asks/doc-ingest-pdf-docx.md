# litectx ask — document store: any-file ingest, name-indexing, scope

**From:** multis (first baresuite customer), migration module **M3** (replace `src/indexer/*` with litectx).
**Against:** litectx **0.16.2** (installed npm artifact; validate, don't assert).
**Date:** 2026-06-18 (supersedes the original PDF/DOCX-parse-only framing of this file).
**Status:** FILED — M3 blocked on R1–R3 (Principle 4: the wait is the validation).

---

## The whole ask, as one ingest rule

```
ingest(bytes, filename, scope = null, meta = {}, expiresAt = null):
  ext = extension(filename)
  if ext is md / code           → chunk + index body          (exists today)
  elif converter wired (pdf,docx) → convert→md, chunk + index   (R0 — litectx claims shipped)
  else (csv, xlsx, xml, binary…) → store blob, index FILENAME only (no body chunk)   (R3)
  every row carries `scope`; unset = null = global/unscoped     (R2)
  every row may carry `expiresAt`; unset = null = keep forever  (R5)
```

litectx ships this **mechanism**; multis owns the **policy** (what the scopes mean). Same line as beeperbox.

## The five requirements

- **R0 — PDF/DOCX → md → chunk.** Convert to md, reuse the md chunker; rows are `kind=doc`, `format=pdf|docx`. **litectx claims this is shipped — pending validation against the installed package** (not a working tree). If confirmed, R0 is done.

- **R1 — Buffer/content ingest entry.** Accept an uploaded file's **bytes + filename** (chat uploads are transient buffers, not repo-root files). Distinct from `index()` (sweeps a root) and `remember()` (verbatim, unchunked). This is what unblocks the chat-upload flow.

- **R2 — `scope` on every row + a `recall` scope filter.** Scope is set **per-upload (at ingest time)** — a chat id — not per-instance (one multis process serves all chats, so `new LiteCtx({owner})` per chat is not viable). `recall({scope})` filters by it. Default **null = unscoped/global**. **A scoped recall returns `scope ∪ null-global`, never any other scope** — global kb stays visible from a customer chat; one customer never sees another's docs. (Implementation — new column vs. extending `owner` — is litectx's call; the requirement is per-upload tagging + scope∪global recall.)

- **R3 — Store any file, byte-exact.** Non-chunkable types (csv/xlsx/xml/binary) are **stored byte-exact in litectx** (a BLOB, not text), retrievable via `get(id)` as the **original bytes**, findable in `recall` by **filename** (not body, not metadata), body **not parsed/chunked**. litectx is the single durable store — multis keeps no parallel file store (the M3 goal). Bounded by a **size cap**; converting to md for body-search stays the consumer's **opt-in**. *Whether the blob tier is opt-in/lazy (like litectx's embeddings peer dep) is litectx's call — the requirement is byte-exact store + retrieve, capped, never parsed.*

- **R4 — Bounds (acceptance criteria).** Size / page / parse-timeout caps + graceful failure on corrupt/encrypted input. Documents are untrusted.

- **R5 — Per-record expiry (retention).** Optional `expiresAt` set at ingest; **null = keep forever**. Expired rows are excluded from `recall`/`get`, and a purge reclaims their storage (including the R3 blob bytes — single store means no orphaned files). **multis owns the policy** — computes the TTL per scope/file from `config.json` (`user:<chat>` 90d, raw blobs shorter, sensitive shorter, `kb`/`admin` = null) and stamps `expiresAt`. **litectx owns the mechanism** — honor `expiresAt` + reclaim. (Lazy-on-recall vs. background purge vs. an explicit `purge()` verb is litectx's call.) The retention *sweep/schedule* itself is multis-lane build work (already on the POC6 to-do: "cron, retention cleanup").

## Acceptance criteria

1. A **PDF buffer** ingested via R1 → `recall(query, {kind:'doc', body:true})` returns readable text, not `%PDF` bytes. (validates R0+R1)
2. A **csv/xlsx buffer** → stored byte-exact; `get(id)` returns the **original bytes** (round-trip identical); `recall("<its filename>")` surfaces it; body **not** parsed/chunked. (validates R3)
3. Docs under **two scopes** + one **global (null)** doc → a recall scoped to X returns **X's docs + the global doc, and nothing from the other scope**; an unscoped recall sees all. (validates R2 — global kb always visible; cross-customer fenced)
4. Oversized / over-page / slow / corrupt inputs → bounded, clear error, index left intact. (validates R4)
5. A row ingested with a **past `expiresAt`** → excluded from `recall`/`get`, and its blob bytes reclaimed on purge; a `null`-expiry row persists. (validates R5)
6. multis can delete `src/indexer/{parsers,chunker,chunk,store}.js` and route `/index` + chat-uploads entirely through litectx.

## Boundary

- **litectx owns:** ingest, format conversion (pdf/docx→md), chunking, storage, name-indexing, scope filtering, ranking, recall.
- **multis owns:** receiving the upload (via beeperbox) and calling ingest with `(bytes, filename, scope, meta)`. No parser, no chunker, no parallel store — those get deleted (the M3 goal).
- **Dropped from the earlier framing:** "open `kind`" — multis's kb-vs-misc is a *scope* axis (R2), not a new kind. litectx's closed-kind / open-`format` design stands.
