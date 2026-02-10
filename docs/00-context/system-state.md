# System State

Current state of the multis codebase as of POC4.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Platforms                                                    │
│  ┌──────────────┐  ┌──────────────┐                          │
│  │  Telegram     │  │  Beeper      │  (localhost:23373)       │
│  │  (Telegraf)   │  │  Desktop API │                          │
│  └──────┬───────┘  └──────┬───────┘                          │
│         │                 │                                   │
│  ┌──────▼─────────────────▼───────────────────────────────┐  │
│  │           Message Router (handlers.js)                  │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │  │
│  │  │ Commands │ │ RAG Ask  │ │ Chat     │ │ Document │  │  │
│  │  │ (exec,   │ │ (search  │ │ Modes    │ │ Upload   │  │  │
│  │  │  read,..)│ │  → LLM)  │ │ (P / B)  │ │ (index)  │  │  │
│  │  └────┬─────┘ └────┬─────┘ └──────────┘ └────┬─────┘  │  │
│  └───────┼─────────────┼────────────────────────┼─────────┘  │
│          │             │                        │             │
│  ┌───────▼──────┐ ┌────▼─────────┐  ┌──────────▼──────────┐ │
│  │  Governance  │ │  LLM Layer   │  │  Indexer             │ │
│  │  (validate,  │ │  (Anthropic, │  │  (PDF, DOCX, MD, TXT │ │
│  │   audit)     │ │   OpenAI,    │  │   → chunks → SQLite) │ │
│  └──────────────┘ │   Ollama)    │  └──────────────────────┘ │
│                   └──────────────┘                            │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              SQLite (FTS5) — ~/.multis/multis.db        │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Source Tree

```
src/
├── index.js              # Entry point — starts Telegram + Beeper
├── config.js             # Load/save ~/.multis/config.json, .env overrides
├── bot/
│   ├── telegram.js       # Telegraf bot setup + legacy handlers
│   └── handlers.js       # Platform-agnostic message router + all commands
├── platforms/
│   ├── base.js           # Platform abstract class
│   ├── message.js        # Normalized Message class (routeAs, isCommand, parseCommand)
│   ├── telegram.js       # Telegram platform adapter
│   └── beeper.js         # Beeper Desktop API adapter (polling, mode routing)
├── governance/
│   ├── validate.js       # Command allowlist/denylist + path restrictions
│   └── audit.js          # Append-only JSON audit log
├── skills/
│   └── executor.js       # execCommand, readFile, listSkills
├── indexer/
│   ├── chunk.js          # DocChunk data class
│   ├── chunker.js        # Hierarchical text chunking (2000ch, 200 overlap)
│   ├── parsers.js        # PDF (pdf-parse), DOCX (mammoth), MD, TXT parsers
│   ├── store.js          # SQLite store with FTS5 + activation columns
│   └── index.js          # DocumentIndexer facade (indexFile, search, getStats)
├── llm/
│   ├── base.js           # LLMProvider abstract class
│   ├── anthropic.js      # Anthropic Claude (native system prompt)
│   ├── openai.js         # OpenAI GPT (system role message)
│   ├── ollama.js         # Ollama local (native system field)
│   ├── client.js         # createLLMClient factory
│   └── prompts.js        # buildRAGPrompt — formats chunks into LLM prompts
├── memory/               # (empty — POC5)
├── retrieval/            # (empty — FTS5 in indexer/store.js covers POC3-4)
└── cli/
    └── setup-beeper.js   # Beeper Desktop token setup wizard
```

## POC Completion Status

| POC | Description | Status | Commit |
|-----|-------------|--------|--------|
| 1 | Telegram echo bot | Done | a889fe5 |
| 2 | Basic skills (exec, read, governance) | Done | 63e0da3 |
| 3 | Document indexing (FTS5 search) | Done | 7ece1c2 |
| 4 | LLM RAG + chat modes | Done | — |
| 5 | Memory + ACT-R | Next | — |
| 6 | Daemon + CLI | Planned | — |
| 7 | Multi-platform (Matrix/Beeper) | Planned | ad98ec8 (platform abstraction) |

## Configuration

All config lives in `~/.multis/`:

| File | Purpose |
|------|---------|
| `config.json` | Main config (platforms, LLM, users, pairing code) |
| `governance.json` | Command allowlist/denylist, path restrictions |
| `multis.db` | SQLite database (document chunks, FTS5 index) |
| `audit.log` | Append-only audit log (JSONL) |
| `beeper-token.json` | Beeper Desktop API token |

## Dependencies

| Package | Purpose |
|---------|---------|
| `telegraf` | Telegram bot framework |
| `better-sqlite3` | SQLite database |
| `pdf-parse` | PDF parsing |
| `mammoth` | DOCX parsing |
