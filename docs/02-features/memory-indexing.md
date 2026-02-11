# Memory and Indexing System

> Comprehensive reference for document indexing, conversation memory, search/retrieval, and RAG prompt composition.

## Overview

multis has two knowledge paths that feed into a unified search layer:

1. **Document indexing** — Files (PDF, DOCX, MD, TXT) parsed into hierarchical chunks and stored in SQLite FTS5
2. **Conversation memory** — Chat messages summarized by LLM and indexed as searchable chunks

Both paths produce `DocChunk` objects stored in the same `chunks` table, searchable with the same BM25 + ACT-R blended ranking, and scoped by the same SQL-level access control.

```
Documents ──→ Parse ──→ Chunk ──→ Store ──┐
                                          ├──→ FTS5 Search ──→ RAG Prompt ──→ LLM
Conversations ──→ Summarize ──→ Index ──┘
```

---

## 1. Document Indexing Pipeline

### 1.1 Parsers (`src/indexer/parsers.js`)

Each parser extracts structured content and returns `DocChunk[]` with hierarchical metadata.

| Format | Library | Strategy |
|--------|---------|----------|
| PDF | pdfjs-dist (PDF.js) | **Tier 1:** TOC/outline → section chunks with breadcrumb hierarchy. **Tier 3:** No TOC → one chunk per page with real per-page text |
| DOCX | mammoth | HTML heading detection (`<h1>`–`<h6>`), section stack for nesting |
| Markdown | built-in | `#` heading levels, section stack for nesting |
| Plain text | built-in | Single chunk per file |

#### PDF Tiered Extraction

```
PDF file
  → pdfjs-dist getDocument()
  → getOutline()
  │
  ├─ Outline exists (Tier 1):
  │   → flattenOutline() → [{title, level, pageNum}, ...]
  │   → For each TOC entry:
  │       content = pages[startPage..nextEntry.page]
  │       sectionPath = buildSectionPath(toc, index)
  │   → DocChunk[] with elementType:'section'
  │
  └─ No outline (Tier 3):
      → Per-page text via getTextContent()
      → Small docs (≤1 page or <500 chars) → single chunk
      → Multi-page → one chunk per page
```

#### DOCX/MD Heading Hierarchy

Both use a `sectionStack` pattern. When a heading is encountered:
1. Pop stack entries at same or deeper level
2. Push new heading onto stack
3. Previous section's content becomes a chunk
4. `sectionPath` = stack entries' names (breadcrumb)

Example for a document with `# Ch1 > ## Sec1.1 > ### Sub1.1.1`:
```
sectionPath: ["Ch1", "Sec1.1", "Sub1.1.1"]
sectionLevel: 3
elementType: "section"
```

### 1.2 DocChunk (`src/indexer/chunk.js`)

The universal data object for all indexed content.

| Field | Type | Purpose |
|-------|------|---------|
| `chunkId` | string | Deterministic: `doc:<sha256(path:name:content[:200])[:16]>` |
| `filePath` | string | Absolute path to source file |
| `pageStart`/`pageEnd` | int | Page boundaries (PDFs) |
| `elementType` | string | `section`, `paragraph`, `memory_summary`, `toc_entry`, `table` |
| `name` | string | Section title or filename |
| `content` | string | Full text content |
| `parentChunkId` | string? | FK to parent chunk |
| `sectionPath` | string[] | Breadcrumb: `["Chapter 2", "2.1 Installation"]` |
| `sectionLevel` | int | Heading depth (1–6), 0 = body text |
| `documentType` | string | `pdf`, `docx`, `md`, `txt`, `conversation` |
| `scope` | string | `kb`, `admin`, or `user:<chatId>` |
| `metadata` | object | Arbitrary JSON |

### 1.3 Chunker (`src/indexer/chunker.js`)

Splits large sections at sentence boundaries. Preserves hierarchy on split chunks.

- **Max size:** 2000 characters
- **Overlap:** 200 characters between consecutive parts
- **Break markers:** `. `, `! `, `? `, `\n\n`, `\n` (tried in order)
- **Output naming:** `"Section Title (part 1)"`, IDs: `<originalId>-p0`, `-p1`
- **Preserved on split:** `sectionPath`, `sectionLevel`, `parentChunkId`, `elementType`

### 1.4 DocumentIndexer (`src/indexer/index.js`)

Orchestrator that wires parse → chunk → store.

```
indexFile(filePath, scope='kb')
  1. Resolve absolute path
  2. getParser(ext) → parser function
  3. deleteByFile(path) — remove old chunks (re-index)
  4. parser(path) → DocChunk[]
  5. chunker.process() → split large chunks
  6. Set scope on all chunks
  7. store.saveChunks() → SQLite
  8. Audit log
```

Also supports:
- `indexBuffer(buffer, filename, scope)` — for Telegram file uploads (writes temp file, indexes, deletes)
- `indexDirectory(dirPath, recursive)` — batch index all supported files

---

## 2. Storage and Search (`src/indexer/store.js`)

### 2.1 Schema

```sql
-- Main storage
CREATE TABLE chunks (
  chunk_id TEXT PRIMARY KEY,
  file_path, page_start, page_end,
  element_type, name, content,
  parent_chunk_id, section_path TEXT,  -- JSON array
  section_level, document_type, metadata TEXT,
  scope TEXT DEFAULT 'kb',
  activation REAL DEFAULT 0.0,         -- cached ACT-R
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  created_at, updated_at
);

-- FTS5 (auto-synced via INSERT/UPDATE/DELETE triggers)
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  chunk_id UNINDEXED,
  name,           -- section title (high signal)
  content,        -- body text
  section_path,   -- breadcrumb (searchable)
  tokenize='porter unicode61'
);

-- ACT-R access tracking
CREATE TABLE access_history (
  chunk_id TEXT, accessed_at TEXT, query TEXT
);
```

FTS5 indexes `name`, `content`, AND `section_path` — so queries matching a section title or breadcrumb path rank higher.

### 2.2 Search Algorithm

```
search(query, limit=10, { scopes, decay })

1. TOKENIZE: lowercase, strip punctuation, remove 150+ stopwords
   "how do I install widgets" → "install widgets"

2. FTS5 QUERY: terms.join(' OR ') → "install OR widgets"

3. SQL with scope enforcement:
   SELECT c.*, rank FROM chunks_fts
   JOIN chunks c ON fts.chunk_id = c.chunk_id
   WHERE chunks_fts MATCH 'install OR widgets'
     AND c.scope IN ('kb', 'user:12345')  -- HARD BOUNDARY
   ORDER BY rank
   LIMIT (limit * 3)  -- 3x candidates for re-ranking

4. BLEND for each candidate:
   bm25 = -row.rank          (FTS5 rank is negative; lower = more relevant)
   activation = computeActivation(chunkId)
   blended = bm25 + 2.0 * activation

5. SORT by blended score descending, return top `limit`
```

### 2.3 ACT-R Activation

Models human memory decay. Chunks accessed recently/frequently score higher.

```
B_i = ln(1 + Σ t_j^-0.5)

where:
  t_j = max(seconds since j-th access, 1)   -- 1s floor avoids infinity
  sum over last 50 accesses
  ln(1 + sum) not ln(sum) — ensures positive activation for single access
```

**Feedback loop:** When search results are shown to the user, `recordSearchAccess()` is called on all returned chunk IDs. This boosts their activation for future queries.

### 2.4 Scope Enforcement

| Scope | Meaning | Who sees it |
|-------|---------|-------------|
| `kb` | Knowledge base (public docs) | Everyone |
| `admin` | Owner-only content | Owner only |
| `user:<chatId>` | Per-user conversation memory | That user + owner |

**Assignment:**
- `/index ~/file.pdf kb` → explicit scope
- `/index ~/file.pdf admin` → explicit scope
- No scope → bot asks (no silent defaults)
- Memory capture → `admin` for owner chats, `user:<chatId>` for others

**Enforcement:** SQL `WHERE c.scope IN (...)` clause. Admin queries pass no scope filter (sees all). Non-admin queries always include `['kb', 'user:<chatId>']`.

Even if a prompt injection tricks the LLM, the SQL query physically cannot return chunks from other users' scopes.

---

## 3. Conversation Memory (`src/memory/`)

### 3.1 Per-Chat File Structure

```
~/.multis/memory/chats/
├── admin/
│   └── memory.md              ← shared across owner's platforms
├── <chatId>/
│   ├── profile.json           ← { mode, platform, lastActive, created }
│   ├── recent.json            ← rolling window of messages
│   ├── memory.md              ← durable LLM summaries
│   └── log/
│       ├── 2026-02-10.md      ← append-only daily log
│       └── 2026-02-11.md
```

### 3.2 ChatMemoryManager (`src/memory/manager.js`)

Handles all per-chat file I/O. Cached by chatId (one manager per chat).

| Method | Purpose |
|--------|---------|
| `loadProfile()` / `saveProfile()` | Read/write `profile.json` |
| `loadRecent()` / `saveRecent()` | Read/write `recent.json` (rolling window) |
| `appendMessage(role, content)` | Add to rolling window |
| `trimRecent(keepLast=5)` | Keep last N messages |
| `loadMemory()` / `appendMemory(notes)` / `clearMemory()` | Durable `memory.md` |
| `pruneMemory(maxSections=5)` | Keep last N sections (split by `## YYYY-` headers) |
| `appendToLog(role, content)` | Append to `log/YYYY-MM-DD.md` |
| `shouldCapture(threshold=20)` | True if rolling window ≥ threshold |

**Admin aggregation:** Owner's memory.md is shared at `admin/memory.md` regardless of platform. Per-chat rolling windows remain separate.

### 3.3 Capture Flow (`src/memory/capture.js`)

When the rolling window exceeds 20 messages, a background capture fires:

```
runCapture(chatId, mem, llm, indexer, opts)

1. Load recent messages from recent.json
2. Load existing memory.md
3. Build capture prompt:
   "Extract facts, preferences, decisions, action items.
    Use concise bullet points. Skip small talk.
    If nothing noteworthy: 'No notable information.'
    Don't repeat what's already in existing memory."
4. LLM summarization (512 tokens, temperature 0.3)
5. If summary is NOT "no notable information":
   a. Append to memory.md with timestamp header
   b. Index summary as FTS chunk:
      - chunkId: mem-<chatId>-<timestamp>
      - elementType: 'memory_summary'
      - documentType: 'conversation'
      - scope: 'admin' or 'user:<chatId>'
6. Prune memory.md (keep last 5 sections)
7. Trim recent.json (keep last 5 messages)
```

**Key design decisions:**
- **Raw messages are NOT indexed** — only LLM summaries become searchable
- **Fire-and-forget** — capture runs in background, doesn't block response
- **Summary chunks are searchable** alongside document chunks via the same FTS5 pipeline

### 3.4 What Gets Stored Where

| Data | Location | Searchable | Retention |
|------|----------|-----------|-----------|
| Raw messages | `recent.json` (rolling window) | No | Trimmed to 5 on capture |
| Raw messages | `log/YYYY-MM-DD.md` (daily) | No | 30 days, auto-cleaned |
| LLM summaries | `memory.md` (durable) | Via FTS chunk | 90 days (admin: 365d) |
| LLM summaries | `chunks` table | Yes (FTS5) | 90 days (admin: 365d) |
| Documents | `chunks` table | Yes (FTS5) | Permanent until re-indexed |

---

## 4. RAG Prompt Composition (`src/llm/prompts.js`)

### 4.1 /ask Flow (with memory + RAG)

`buildMemorySystemPrompt(memoryMd, chunks)` produces:

```
┌──────────────────────────────────────┐
│ Base system prompt                   │
│ "You are multis, a personal          │
│  assistant. Answer from documents.   │
│  Cite sources. If docs don't have    │
│  the answer, say so clearly."        │
├──────────────────────────────────────┤
│ ## Memory                            │
│ <memory.md contents>                 │
├──────────────────────────────────────┤
│ ## Relevant documents                │
│ --- [filename, page X] ---           │
│ <chunk.content>                      │
│                                      │
│ --- [filename, Section Title] ---    │
│ <chunk.content>                      │
└──────────────────────────────────────┘
```

This system prompt is combined with the rolling window messages for `generateWithMessages()`.

### 4.2 Standalone RAG (no conversation history)

`buildRAGPrompt(question, chunks)` embeds documents in the user message:

```
system: base prompt
user:
  --- [filename, meta] ---
  content

  --- [filename, meta] ---
  content

  ---
  Question: <question>
```

---

## 5. End-to-End: User Asks a Question

```
User: "How do I install the widget?"

1. APPEND to recent.json + daily log

2. SEARCH indexed docs (scoped):
   → "install widget" (after stopword removal)
   → FTS5 MATCH 'install OR widget'
   → WHERE scope IN ('kb', 'user:12345')
   → 15 candidates → compute activation → blend → top 5

3. BUILD PROMPT:
   system = base prompt + memory.md + 5 chunks
   messages = recent.json (last 20 messages)

4. LLM GENERATION → answer

5. SEND answer to chat

6. APPEND assistant response to recent.json + daily log

7. RECORD ACCESS on 5 returned chunks
   → their activation increases for future queries

8. CHECK CAPTURE THRESHOLD (20 messages):
   → If exceeded, background:
     → LLM summarize conversation
     → Append to memory.md
     → Index summary as FTS chunk
     → Prune memory.md to 5 sections
     → Trim recent.json to 5 messages
```

---

## 6. Commands Reference

| Command | What it does |
|---------|-------------|
| `/index <path> <scope>` | Parse file/directory → chunk → store with scope (kb or admin) |
| `/search <query>` | FTS5 + ACT-R search, scoped to caller |
| `/ask <question>` | Search + memory + LLM generation |
| Plain text | Implicit `/ask` |
| `/memory` | Show current memory.md for this chat |
| `/remember <note>` | Append note to memory.md |
| `/forget` | Clear memory.md for this chat |
| `/docs` | Show indexing stats (chunk counts, file counts) |
| File upload (Telegram) | Auto-index uploaded PDF/DOCX/MD/TXT |
