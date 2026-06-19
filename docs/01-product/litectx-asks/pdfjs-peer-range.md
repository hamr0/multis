# litectx ask — widen the `pdfjs-dist` peer range to admit 5.x

**From:** multis (first baresuite customer), module **M3**.
**Against:** litectx **0.17.0** (installed npm artifact; proven, not asserted).
**Date:** 2026-06-18.
**Severity:** LOW — packaging only; runtime is unaffected (proven below).
**Status:** FILED — blocks a *clean* `npm install` of litectx into multis (the M3 dep-add), not the capability.

---

## Finding

litectx 0.17.0 declares `peerDependenciesMeta.pdfjs-dist.optional = true` with range **`pdfjs-dist@^4.0.0`**. multis is on **`pdfjs-dist@^5.4.624`** (current line). npm errors on a *present* optional peer whose version is out of range, so `npm install litectx@0.17.0` fails with `ERESOLVE … Conflicting peer dependency: pdfjs-dist@4.10.38` unless the consumer passes `--legacy-peer-deps`/`--force` — which is a paper-over multis won't ship.

```
peerOptional pdfjs-dist@"^4.0.0" from litectx@0.17.0
Found: pdfjs-dist@5.4.624 (root project)
```

## It's cosmetic — the range is pinned one major behind, the API works on 5.x (proven)

litectx's only pdfjs surface (`node_modules/litectx/src/docparse.js`) is:
- import `pdfjs-dist/legacy/build/pdf.mjs` → `getDocument({ data, … }).promise`
- `page.getTextContent()`

All three are **stable across pdfjs-dist 4.x and 5.x**. Verified directly against the installed `pdfjs-dist@5.4.624`:
- the `legacy/build/pdf.mjs` subpath resolves and `getDocument`/`getTextContent` extract text;
- the **full litectx R0 PDF path** (`ctx.ingest(pdfBuffer)` → `recall({kind:'doc', body:true})`) returns readable text (not `%PDF` bytes) under pdfjs 5.x — AC1 of the M3 validation, green.

## The ask

Widen the optional peer range to admit the current major:

```jsonc
"peerDependencies":     { "pdfjs-dist": "^4.0.0 || ^5.0.0" }   // or ">=4"
```

One line. No code change — the parsing path is already compatible. A patch release (0.17.1) lets multis add litectx as a clean dependency with no install flags.

## Out of scope / non-asks

- `mammoth@^1.8.0` and `better-sqlite3@^11.8.1` peers resolve cleanly against multis (`mammoth ^1.8.0`, `better-sqlite3 11.10.0`) — no change needed.
- The capability itself (R0–R5) is fully delivered and validated; this is purely the install-resolution declaration.
