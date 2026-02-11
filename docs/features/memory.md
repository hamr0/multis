# Memory System

How multis remembers, indexes, searches, and forgets.

## Overview

multis has two complementary memory systems:

1. **Document Index** — files you explicitly index (`/index`), stored as chunks in SQLite with FTS5 full-text search and ACT-R activation-based ranking.
2. **Conversation Memory** — per-chat rolling window of recent messages, LLM-summarized durable notes, and daily logs.

Both systems feed into RAG (Retrieval-Augmented Generation) when answering questions. The LLM sees: system prompt + memory notes + relevant chunks + recent conversation.

---

## Document Indexing Pipeline

When you run `/index ~/report.pdf kb`, this happens:

```
/index ~/report.pdf kb
  │
  ▼
┌─────────────────────────────────────────────┐
│ 1. PARSE (src/indexer/parsers.js)           │
│                                             │
│ PDF  → pdfjs-dist → TOC sections or pages   │
│ DOCX → mammoth → HTML → split by headings   │
│ MD   → native → split by # headings         │
│ TXT  → single chunk per file                │
│                                             │
│ Output: DocChunk[] with filePath, name,     │
│   content, sectionPath, sectionLevel,       │
│   elementType, documentType                 │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│ 2. CHUNK (src/indexer/chunker.js)           │
│                                             │
│ For each chunk > 2000 chars:                │
│   Split at sentence boundaries (. ! ? \n)   │
│   with 200-char overlap between parts       │
│   Creates: chunkId-p0, chunkId-p1, ...      │
│                                             │
│ Small chunks pass through unchanged.        │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│ 3. SCOPE ASSIGNMENT (src/indexer/index.js)  │
│                                             │
│ Each chunk gets: chunk.scope = 'kb'         │
│   (or 'admin', 'user:<chatId>')             │
│                                             │
│ Scope determines who can see this chunk     │
│ during search (see Data Isolation below).   │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│ 4. STORE (src/indexer/store.js)             │
│                                             │
│ INSERT OR REPLACE into SQLite `chunks`:     │
│   chunk_id, file_path, name, content,       │
│   section_path, section_level, scope,       │
│   element_type, document_type, metadata,    │
│   activation, access_count, last_accessed,  │
│   created_at, updated_at                    │
│                                             │
│ FTS5 virtual table auto-synced via triggers │
│ on name + content + section_path            │
└─────────────────────────────────────────────┘
```

### Chunk ID Generation

Each chunk gets a deterministic ID: `doc:<sha256(filePath:name:content[:200])[:16]>`. Re-indexing the same file replaces existing chunks (DELETE + INSERT).

### Supported Formats

| Format | Parser | Chunking Strategy |
|--------|--------|-------------------|
| PDF | pdfjs-dist | TOC-based sections (Tier 1) or per-page (Tier 3) |
| DOCX | mammoth → HTML | Split by heading hierarchy (h1-h6) |
| Markdown | Native | Split by `#` heading levels |
| Plain text | Native | Single chunk per file |

### File Uploads (Telegram)

Sending a file to the bot downloads it, writes to `~/.multis/tmp/`, indexes with scope `kb`, then deletes the temp file.

---

## Search: BM25 + ACT-R Activation

Search combines two signals:

### BM25 (Text Relevance)

FTS5 full-text search with Porter stemming and Unicode support. Query processing:

1. Lowercase input, strip punctuation
2. Remove stopwords (150+ common English words)
3. Join remaining terms with OR for broad matching
4. FTS5 MATCH returns BM25 rank (negative float, lower = more relevant)

### ACT-R Activation (Usage Recency/Frequency)

Based on the ACT-R cognitive architecture's base-level activation equation:

```
B_i = ln(1 + Σ t_j^-d)
```

Where:
- `B_i` = base-level activation of chunk `i`
- `t_j` = seconds since the j-th access (capped at minimum 1 second)
- `d` = decay rate (default 0.5)
- Sum is over the last 50 accesses

**What this means in practice:**
- Chunks accessed recently have high activation
- Chunks accessed frequently have high activation
- Old, unused chunks decay toward 0
- A chunk accessed once 5 minutes ago scores higher than one accessed once last week
- A chunk accessed 10 times today scores higher than one accessed once today

### Blended Ranking

The final search score blends both signals:

```
blended_score = bm25_score + ACTIVATION_WEIGHT * activation
```

Where `ACTIVATION_WEIGHT = 2.0` (configurable in code).

**Process:**
1. Fetch 3x the requested limit from FTS5 (candidates)
2. For each candidate, compute activation from `access_history` table
3. Compute blended score
4. Sort by blended score descending, return top N

**Result:** A document about "neural networks" that you searched for yesterday will rank higher than an equally relevant document you haven't touched in months.

### Access Recording

Every time search results are shown to a user (via `/search` or `/ask`), each returned chunk gets an access record:

- Inserted into `access_history(chunk_id, accessed_at, query)`
- `access_count` incremented on the chunk row
- `activation` recomputed and cached on the chunk row

This creates a feedback loop: chunks you use become easier to find.

---

## Data Isolation (Scopes)

Every chunk has a `scope` that controls visibility:

| Scope | Who can see it | Set by |
|-------|---------------|--------|
| `kb` | Everyone (public knowledge base) | `/index path kb` or file upload |
| `admin` | Owner only | `/index path admin` |
| `user:<chatId>` | That specific chat only | Automatic on memory capture |

### Search Filtering

```
Admin (owner):    sees everything (no scope filter)
Non-admin user:   sees only 'kb' + 'user:<their chatId>'
```

The scope filter is applied as a SQL `WHERE c.scope IN (...)` clause, enforced at the database level. This is the hard security boundary — even if prompt injection bypasses the LLM, the SQL query physically cannot return chunks from other users' scopes.

### /index Command

```
/index ~/report.pdf kb      → indexed as public knowledge base
/index ~/personal.pdf admin → indexed as owner-only
/index ~/report.pdf         → bot asks: "Label as kb or admin?"
```

No silent defaults — you must explicitly choose.

---

## Conversation Memory

Per-chat memory managed by `ChatMemoryManager` (`src/memory/manager.js`).

### File Structure

```
~/.multis/memory/chats/
  ├── admin/
  │   └── memory.md          ← shared across all owner chats
  ├── <chatId-1>/
  │   ├── profile.json        ← mode (personal/business), platform, timestamps
  │   ├── recent.json          ← rolling window of recent messages
  │   ├── memory.md            ← durable LLM-summarized notes
  │   └── log/
  │       ├── 2026-02-10.md    ← daily append-only log
  │       └── 2026-02-11.md
  └── <chatId-2>/
      └── ...
```

### Rolling Window (recent.json)

An array of `{ role, content, timestamp }` objects. Every user message and assistant response is appended here. This is what the LLM sees as conversation context.

When the window reaches `capture_threshold` (default 20 messages), the capture process fires.

### Memory Capture

When `recent.json` grows past the threshold (fire-and-forget, doesn't block the response):

```
recent.json (20+ messages)
  │
  ▼
┌──────────────────────────────────────────┐
│ 1. LLM SUMMARIZATION                    │
│                                          │
│ System: "Extract facts, preferences,     │
│   decisions, action items. Skip small    │
│   talk. Don't repeat existing memory."   │
│                                          │
│ Input: all recent messages               │
│ Output: concise bullet-point summary     │
│                                          │
│ If "no notable information" → skip       │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│ 2. APPEND TO memory.md                   │
│                                          │
│ ## 2026-02-11T14:30:00.000Z             │
│ - User prefers dark mode                │
│ - Decided to use PostgreSQL for project │
│ - Action: send report by Friday         │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│ 3. INDEX SUMMARY AS FTS CHUNK            │
│                                          │
│ chunkId: mem-<chatId>-<timestamp>       │
│ elementType: memory_summary             │
│ documentType: conversation              │
│ scope: admin | user:<chatId>            │
│                                          │
│ This makes conversation summaries        │
│ searchable via FTS5, just like documents │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│ 4. PRUNE memory.md                       │
│                                          │
│ Keep only last N sections (default 5)   │
│ Split by "## YYYY-" headers             │
│ Oldest sections dropped                 │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│ 5. TRIM recent.json                      │
│                                          │
│ Keep last 5 messages                    │
│ Conversation continues from here        │
└──────────────────────────────────────────┘
```

**Key design decision:** Raw messages are NOT indexed into FTS. Only LLM summaries are. This keeps the search index clean and relevant — no "hello" or "thanks" cluttering results.

### Admin Memory Aggregation

Owner (admin) chats from any platform share a single `~/.multis/memory/chats/admin/memory.md`. This means:

- You chat with the bot on Telegram → memory saved to `admin/memory.md`
- You chat with the bot on Beeper → same `admin/memory.md`
- Your preferences and notes persist across platforms

Per-chat rolling windows (`recent.json`) remain separate per chat ID — only durable memory is shared.

### Daily Logs

Every message (user and assistant) is appended to `log/YYYY-MM-DD.md` as:

```
### 14:30:00 [user]
What's the status of the project?

### 14:30:02 [assistant]
Based on the last update, the project is on track...
```

Logs are backup-only — never searched, never fed to the LLM. Automatically deleted after `log_retention_days` (default 30 days).

---

## What the LLM Sees

When you send a message, the system prompt is composed of:

```
┌─────────────────────────────────────┐
│ Base system prompt                  │
│ (You are a helpful assistant...)    │
├─────────────────────────────────────┤
│ memory.md contents                  │
│ (Durable notes from past captures)  │
├─────────────────────────────────────┤
│ Top 5 FTS chunks (if relevant)      │
│ (From documents + memory summaries) │
├─────────────────────────────────────┤
│ recent.json messages                │
│ (Last 5-20 messages as context)     │
├─────────────────────────────────────┤
│ Current user message                │
└─────────────────────────────────────┘
```

This gives the LLM: long-term memory (notes), relevant knowledge (chunks), and short-term context (recent conversation).

---

## Retention and Cleanup

| Data | Default Retention | Configurable |
|------|-------------------|-------------|
| memory.md sections | Last 5 sections | `memory.memory_max_sections` |
| Memory FTS chunks | 90 days | `memory.retention_days` |
| Admin memory chunks | 365 days | `memory.admin_retention_days` |
| Daily logs | 30 days | `memory.log_retention_days` |
| Document chunks (kb/admin) | Forever | Manual re-index to update |

Cleanup runs:
- On startup
- Every 24 hours via `setInterval`

Old conversation chunks are deleted from SQLite. Old log files are deleted from disk.

---

## Commands

| Command | What it does |
|---------|-------------|
| `/index <path> <kb\|admin>` | Parse, chunk, and store a document with explicit scope |
| `/search <query>` | BM25 + activation search, scoped to caller's visibility |
| `/ask <question>` | Search + LLM answer with full memory context |
| `/memory` | Show current chat's durable memory notes |
| `/remember <note>` | Manually append a note to memory.md |
| `/forget` | Clear this chat's memory.md |
| `/docs` | Show indexing stats (chunk counts by type) |

Plain text messages are treated as implicit `/ask`.

---

## Configuration

All in `~/.multis/config.json`:

```json
{
  "memory": {
    "enabled": true,
    "recent_window": 20,
    "capture_threshold": 20,
    "memory_max_sections": 5,
    "retention_days": 90,
    "admin_retention_days": 365,
    "log_retention_days": 30,
    "decay_rate": 0.05
  }
}
```

---

## Database Schema

```sql
-- Main chunk storage
CREATE TABLE chunks (
  chunk_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  page_start INTEGER, page_end INTEGER,
  element_type TEXT,    -- paragraph, section, toc_entry, memory_summary
  name TEXT,
  content TEXT,
  parent_chunk_id TEXT,
  section_path TEXT,    -- JSON array: ["Chapter 1", "Section 1.2"]
  section_level INTEGER,
  document_type TEXT,   -- pdf, docx, md, txt, conversation
  metadata TEXT,        -- JSON object
  scope TEXT,           -- kb, admin, user:<chatId>
  activation REAL,      -- cached ACT-R activation value
  access_count INTEGER,
  last_accessed TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- FTS5 full-text search (auto-synced via triggers)
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  chunk_id UNINDEXED, name, content, section_path,
  content=chunks, tokenize='porter unicode61'
);

-- Access history for ACT-R decay computation
CREATE TABLE access_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  query TEXT,
  FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE
);
```

---

## How It All Connects

```
User: "What did we decide about the database?"
  │
  ├─ 1. Append to recent.json + daily log
  │
  ├─ 2. FTS5 search "decide database" → 3x candidates
  │     ├─ doc chunk from indexed PDF (scope: kb)
  │     ├─ memory_summary chunk from past capture (scope: admin)
  │     └─ ... filtered by caller's scope
  │
  ├─ 3. Compute activation for each candidate
  │     └─ Blend BM25 + ACT-R → re-rank → top 5
  │
  ├─ 4. Build prompt: memory.md + top chunks + recent messages
  │
  ├─ 5. LLM generates answer using full context
  │
  ├─ 6. Send answer, append to recent.json + daily log
  │
  ├─ 7. Record access on returned chunks (feeds activation)
  │
  └─ 8. If recent.json > threshold → fire capture
        └─ Summarize → append memory.md → index summary → prune → trim
```
