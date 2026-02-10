# multis Architecture

## Overview

multis is a local-first personal chatbot and assistant built with Node.js.

## Core Principles

1. **Local-first:** All data stays on your machine
2. **LLM agnostic:** Works with Anthropic, OpenAI, Ollama, etc.
3. **Governance-first:** Command allowlist/denylist + audit logs
4. **Vanilla Node.js:** Standard library first, minimal dependencies
5. **Simple:** No overengineering, no bloat

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Telegram Bot                         │
│                     (Interface)                         │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                  multis Daemon                          │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────────┐ │
│  │ Bot Handler │  │ Governance  │  │  LLM Client    │ │
│  │  (Telegraf) │  │  (Validate) │  │ (Multi-provider│ │
│  └──────┬──────┘  └──────┬──────┘  └────────┬───────┘ │
│         │                │                   │         │
│  ┌──────▼────────────────▼───────────────────▼──────┐  │
│  │              Command Router                       │  │
│  └──────┬───────────────────────────────────────────┘  │
│         │                                               │
│  ┌──────▼──────┐  ┌──────────┐  ┌──────────────────┐  │
│  │   Skills    │  │ Indexer  │  │     Memory       │  │
│  │ (shell,file)│  │(PDF/DOCX)│  │  (ACT-R + SQLite)│  │
│  └──────┬──────┘  └────┬─────┘  └────────┬─────────┘  │
│         │              │                  │            │
│  ┌──────▼──────────────▼──────────────────▼─────────┐  │
│  │              Data Layer (SQLite)                  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Components

### 1. Bot Layer (`src/bot/`)
- **telegram.js:** Telegraf bot setup
- **handlers.js:** Message/command handlers
- **middleware.js:** Pairing, rate limiting

**Responsibilities:**
- Receive messages from Telegram
- Parse commands
- Send responses

### 2. Governance Layer (`src/governance/`)
- **validate.js:** Check allowlist/denylist
- **audit.js:** Append-only audit log
- **confirm.js:** Confirmation prompts

**Responsibilities:**
- Enforce command policies
- Log all actions
- Require confirmation for risky commands

### 3. Skills Layer (`src/skills/`)
- **shell.js:** Execute shell commands
- **files.js:** File operations
- **web.js:** Web search
- **system.js:** System info

**Responsibilities:**
- Implement assistant capabilities
- Validate via governance before execution
- Return results to bot

### 4. Indexer Layer (`src/indexer/`)
- **pdf.js:** Parse PDF files
- **docx.js:** Parse DOCX files
- **chunker.js:** Text chunking
- **index.js:** Index documents

**Responsibilities:**
- Parse uploaded documents
- Chunk text for search
- Store in SQLite

### 5. Retrieval Layer (`src/retrieval/`)
- **bm25.js:** BM25 search algorithm
- **semantic.js:** Semantic search (embeddings)
- **hybrid.js:** Combine BM25 + semantic

**Responsibilities:**
- Search indexed documents
- Rank results by relevance
- Return top K chunks

### 6. LLM Layer (`src/llm/`)
- **base.js:** LLM provider interface
- **anthropic.js:** Anthropic Claude provider
- **openai.js:** OpenAI GPT provider
- **ollama.js:** Ollama local provider
- **client.js:** Provider factory

**Responsibilities:**
- Abstract LLM providers
- Generate responses
- Handle tool calling

### 7. Memory Layer (`src/memory/`)
- **store.js:** SQLite wrapper
- **actr.js:** ACT-R activation/decay
- **sync.js:** Watch memory files
- **export.js:** Export to memory.md

**Responsibilities:**
- Store conversation history
- Calculate activation scores
- Retrieve relevant context
- Export human-readable logs

### 8. CLI Layer (`src/cli/`)
- **init.js:** Onboarding wizard
- **daemon.js:** Start/stop daemon
- **status.js:** Check daemon status

**Responsibilities:**
- Initialize configuration
- Manage daemon lifecycle
- Provide user-friendly CLI

## Data Flow

### 1. User sends message

```
User → Telegram → Bot Handler → Pairing Check
```

### 2. Command execution

```
Bot Handler → Governance Validate → Skill Execute → Audit Log → Response
```

### 3. Document query

```
Bot Handler → Retrieval Search → LLM Generate → Response
```

### 4. Memory retrieval

```
Bot Handler → Memory ACT-R → Recent Context → LLM Generate → Response
```

## Configuration

### User Configuration (`~/.multis/config.json`)
- Telegram bot token
- Pairing code
- Allowed users
- LLM provider settings
- Memory settings

### Governance Configuration (`~/.multis/governance.json`)
- Command allowlist/denylist
- Path restrictions
- Rate limits

### Environment Variables (`.env`)
- `TELEGRAM_BOT_TOKEN`
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
- `LLM_PROVIDER`
- `LLM_MODEL`

## Database Schema

### SQLite (`~/.multis/multis.db`)

```sql
-- Documents
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chunks (for search)
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  page_number INTEGER,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

-- Full-text search
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id'
);

-- Conversations (memory)
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  role TEXT NOT NULL,  -- 'user' or 'assistant'
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  base_activation REAL DEFAULT 1.0,
  last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  access_count INTEGER DEFAULT 1
);
```

## Security

### Pairing
- Generate random pairing code (8-char hex)
- User must send code to bot
- Only paired users can interact

### Command Validation
- Allowlist: Only approved commands
- Denylist: Explicitly blocked commands
- Path restrictions: Only access allowed directories

### Audit Logging
- All commands logged (append-only)
- Tamper-evident (newline-delimited JSON)
- Includes: timestamp, user, command, result

### Rate Limiting
- 10 messages per minute per user
- 5 commands per minute per user

## Performance

### Indexing
- PDF parsing: ~100 pages/sec
- Chunking: ~1000 chunks/sec
- SQLite FTS: <100ms per query

### Search
- BM25: <50ms for 1000 documents
- Semantic: ~200ms (if using embeddings)
- Hybrid: ~250ms total

### Memory
- ACT-R calculation: <1ms per conversation
- SQLite query: <10ms for recent messages

## Borrowed Patterns

### From openclaw
- Daemon architecture
- Pairing flow
- Skill.md pattern
- memory.md approach
- Cron-based sync

### From Aurora
- Document indexing pipeline
- ACT-R memory model
- Hybrid retrieval (BM25 + semantic)
- SQLite schema

### From mcp-gov
- Governance layer (allowlist/denylist)
- Audit logging
- JSON-based policies

## Multi-Platform (POC7)

See [MULTI_PLATFORM_PLAN.md](MULTI_PLATFORM_PLAN.md) for the full plan.

- **Path 1**: Telegram (mandatory, direct Bot API, zero infra)
- **Path 2**: Matrix self-hosted (optional, per-user VPS with Synapse + mautrix bridges)
- **Beeper**: Evaluated and rejected — iOS hijacks cross-signing, no programmatic verification
- **Element**: Same Synapse under the hood, no personal plan, no bridges included
- **One config**: `~/.multis/config.json` with `platforms` block — fill in what you have, leave rest null

## Future Enhancements

- [ ] Web UI for onboarding
- [ ] Browser control (Playwright)
- [ ] Calendar integration
- [ ] Voice commands (Whisper)
- [ ] Image understanding (vision models)
