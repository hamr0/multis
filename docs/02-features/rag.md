# Document Indexing and RAG

## Overview

multis indexes local documents (PDF, DOCX, MD, TXT) into SQLite with FTS5, then uses retrieved chunks as context for LLM answers.

## Indexing Pipeline

```
File → Parser → Sections → Chunker → SQLite (FTS5)
```

### Parsers (`src/indexer/parsers.js`)

| Format | Library | Output |
|--------|---------|--------|
| PDF | pdfjs-dist | TOC-based sections (outline) or per-page text |
| DOCX | mammoth | HTML → text with heading detection |
| Markdown | built-in | Heading-based sections |
| Plain text | built-in | Raw text |

### Chunking (`src/indexer/chunker.js`)

- **Strategy:** Hierarchical section-based chunking
- **Chunk size:** 2000 characters
- **Overlap:** 200 characters
- **Boundaries:** Sentence-aware (splits at `.`, `!`, `?`)
- **Section path:** Preserved from headings (e.g., `Chapter 1 > Section 1.2 > Subsection`)

### Storage (`src/indexer/store.js`)

SQLite with FTS5 virtual table for full-text search:

```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  name TEXT,               -- filename
  document_type TEXT,      -- pdf, docx, md, txt
  section_path TEXT,       -- JSON array of heading hierarchy
  content TEXT,
  page_start INTEGER,
  page_end INTEGER,
  base_activation REAL,    -- pre-built for ACT-R (POC5)
  last_accessed TEXT,
  access_count INTEGER
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='chunks', content_rowid='id');
```

### Query Processing

- Tokenizes query, removes stopwords
- Joins tokens with OR for FTS5 MATCH
- Returns top K results ranked by BM25

## RAG Pipeline (POC4)

```
Question → FTS5 Search (top 5) → buildRAGPrompt → LLM → Answer
```

### Prompt Builder (`src/llm/prompts.js`)

**System prompt:**
> You are multis, a personal assistant. Answer based on the provided documents. Cite sources as [filename, page X]. If documents don't contain the answer, say so clearly.

**User prompt:** Each chunk formatted with source metadata, then the question.

### LLM Providers

All providers support `options.system` for the system prompt:

| Provider | System Prompt Method | Base URL |
|----------|---------------------|----------|
| Anthropic | Native `system` field in API body | Hardcoded `api.anthropic.com` |
| OpenAI | `{ role: 'system' }` message | Hardcoded `api.openai.com` |
| Ollama | Native `system` field in generate API | Configurable (`OLLAMA_URL`) |

**Limitation:** OpenAI provider won't work with OpenAI-compatible APIs (GLM, Groq, Together, vLLM) because hostname is hardcoded. Needs `baseUrl` config (polish pass). Ollama already supports custom base URL.

## Commands

| Command | Description |
|---------|-------------|
| `/index <path>` | Index a file or directory (owner only) |
| `/search <query>` | Search indexed documents (raw chunks) |
| `/ask <question>` | RAG answer with LLM + citations |
| `/docs` | Show indexing stats |
| File upload | Send a file to Telegram bot to index it |

Plain text messages (Telegram or Beeper personal chat) are treated as implicit `/ask`.
