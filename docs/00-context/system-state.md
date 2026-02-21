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
│   ├── handlers.js       # Platform-agnostic message router + all commands
│   ├── checkpoint.js     # Human approval gate for irreversible tool actions
│   └── scheduler.js      # /remind, /cron, /jobs, /cancel via bare-agent Scheduler
├── platforms/
│   ├── base.js           # Platform abstract class
│   ├── message.js        # Normalized Message class (routeAs, isCommand, parseCommand)
│   ├── telegram.js       # Telegram platform adapter
│   └── beeper.js         # Beeper Desktop API adapter (polling, mode routing)
├── governance/
│   ├── validate.js       # Command allowlist/denylist + path restrictions
│   └── audit.js          # Append-only JSON audit log
├── tools/
│   ├── definitions.js    # 25+ tool definitions across desktop, Android, universal
│   ├── registry.js       # Platform filtering, owner-only gating, config overrides
│   ├── adapter.js        # Converts multis tools to bare-agent format with ctx closure
│   └── platform.js       # Runtime platform detection (linux/macos/android)
├── indexer/
│   ├── chunk.js          # DocChunk data class
│   ├── chunker.js        # Hierarchical text chunking (2000ch, 200 overlap)
│   ├── parsers.js        # PDF (pdfjs-dist), DOCX (mammoth), MD, TXT parsers
│   ├── store.js          # SQLite store with FTS5 + activation columns
│   └── index.js          # DocumentIndexer facade (indexFile, search, getStats)
├── llm/
│   ├── provider-adapter.js # Maps multis config to bare-agent providers
│   └── prompts.js        # buildRAGPrompt — formats chunks into LLM prompts
├── memory/
│   ├── manager.js        # ChatMemoryManager — per-chat file I/O
│   └── capture.js        # LLM-summarized durable notes on window overflow
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
| `pdfjs-dist` | PDF parsing (TOC + per-page text) |
| `mammoth` | DOCX parsing |
