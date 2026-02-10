# Product Requirements — POC Roadmap

**Goal:** Build a personal chatbot + assistant that runs locally, incrementally validating each capability.

## POC 1: Telegram Echo Bot (Done)

**Goal:** Prove bot connection works.

- Telegram bot using Telegraf
- Echo messages back to user
- Pairing code authentication
- Deep link support (`t.me/multis02bot?start=<code>`)

## POC 2: Basic Skills (Done)

**Goal:** Prove personal assistant use case.

- Shell skill: execute allowlisted commands (`/exec`)
- File skill: read files and directories (`/read`)
- Governance layer: allowlist/denylist + audit log
- Owner model: first paired user becomes owner

## POC 3: Document Indexing (Done)

**Goal:** Prove document retrieval works (no LLM yet).

- Parse PDF, DOCX, MD, TXT files
- Hierarchical section-based chunking
- SQLite FTS5 for BM25 search
- `/index <path>`, `/search <query>`, `/docs` commands
- Telegram file upload support

## POC 4: LLM RAG + Chat Modes (Done)

**Goal:** Search docs, pass to LLM, get answers with citations.

- `/ask <question>` — RAG pipeline (search -> prompt -> LLM -> answer)
- Plain text messages treated as implicit `/ask`
- Chat modes for Beeper: `personal` (self-chat natural language) and `business` (auto-respond)
- System prompt support for all three LLM providers

## POC 5: Memory + ACT-R

**Goal:** Prove conversation context works.

- Store conversation history in SQLite
- ACT-R activation/decay model
- Bot remembers previous messages
- Export to memory.md (human-readable)

## POC 6: Daemon + CLI

**Goal:** Prove installation works.

- `multis init` wizard (creates config, pairs with Telegram)
- `multis start` / `multis stop` (daemon lifecycle)
- Auto-start on reboot (systemd/launchd)

## POC 7: Multi-Platform Messaging

**Goal:** Connect to WhatsApp, Signal, Discord via Beeper/Matrix.

**Three paths (use what you have):**
1. Telegram (mandatory, zero infra) — always available
2. Beeper Desktop API (localhost, requires Desktop running)
3. Self-hosted Matrix + mautrix bridges (requires VPS, $5-10/month)

See [multi-platform.md](../02-features/multi-platform.md) for full design.

## Timeline

| POC | Estimate | Status |
|-----|----------|--------|
| 1 | 1 day | Done |
| 2 | 1-2 days | Done |
| 3 | 2 days | Done |
| 4 | 1 day | Done |
| 5 | 2 days | Next |
| 6 | 2 days | Planned |
| 7 | 3-5 days | Planned |

**Total: 12-16 days for full MVP with multi-platform**

## Dependencies

### Required (POC 1-6)
- `telegraf` — Telegram bot framework
- `better-sqlite3` — SQLite database
- `pdf-parse` — PDF parsing
- `mammoth` — DOCX parsing

### Required (POC 7)
- Beeper Desktop (for Path 2)
- VPS + Docker + mautrix bridges (for Path 3)

## Constraints

- Node.js vanilla (standard library first)
- Each POC < 500 lines of code
- Self-contained (works offline except LLM calls)
- Fast setup (< 5 minutes from clone to running bot)
