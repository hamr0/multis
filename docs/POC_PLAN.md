# multis POC Plan

**Goal:** Build a personal chatbot + assistant that runs locally, incrementally validating each capability.

## POC Sequence

### POC 1: Telegram Echo Bot (1 day)
**Goal:** Prove bot connection works

**Scope:**
- Telegram bot using Telegraf
- Echo messages back to user
- Pairing code authentication
- One command to run: `node src/index.js`

**Exit Criteria:**
1. User creates bot via @BotFather
2. User runs `node src/index.js`
3. User sends pairing code → paired
4. User sends "Hello" → bot replies "Echo: Hello"

**Files to create:**
- `src/bot/telegram.js` - Telegraf setup
- `src/bot/handlers.js` - Message handlers
- `src/index.js` - Entry point
- `src/config.js` - Load config from ~/.multis/config.json

---

### POC 2: Basic Skills (1-2 days)
**Goal:** Prove personal assistant use case (no docs needed!)

**Scope:**
- Shell skill: Execute allowlisted commands
- Files skill: List/read files
- Governance layer: Validate commands, audit log

**Exit Criteria:**
1. `/exec ls ~/Documents` → bot runs command, returns output
2. `/exec rm -rf /` → bot denies (not in allowlist), logs to audit
3. `/files ~/Documents/*.pdf` → bot lists PDF files
4. Check `~/.multis/audit.log` → all commands logged

**Files to create:**
- `src/skills/shell.js` - Execute shell commands
- `src/skills/files.js` - File operations
- `src/governance/validate.js` - Command validation
- `src/governance/audit.js` - Audit logging

---

### POC 3: Document Indexing (2 days)
**Goal:** Prove document retrieval works (no LLM yet)

**Scope:**
- `/upload` command accepts PDF file
- Parse PDF → chunk text → store in SQLite
- `/search <query>` returns top 3 raw chunks (BM25 search)

**Exit Criteria:**
1. `/upload` → user sends PDF → bot replies "Indexed 47 chunks"
2. `/search climate change` → bot returns 3 raw text chunks

**Files to create:**
- `src/indexer/pdf.js` - Parse PDFs (pdf-parse)
- `src/indexer/docx.js` - Parse DOCX (mammoth)
- `src/indexer/chunker.js` - Text chunking
- `src/indexer/index.js` - Index documents
- `src/retrieval/bm25.js` - BM25 search

---

### POC 4: LLM RAG (1 day)
**Goal:** Prove RAG works (search → LLM → answer)

**Scope:**
- `/ask <question>` searches docs → passes chunks to LLM → returns natural answer
- Show source citations (filename, page number)

**Exit Criteria:**
1. `/ask What is X?` (no relevant docs) → "I don't have information about that"
2. `/ask <question from doc>` → "According to [filename] page 3, ..."

**Files to create:**
- `src/llm/client.js` - Multi-provider LLM client
- `src/llm/anthropic.js` - Anthropic provider
- `src/llm/openai.js` - OpenAI provider
- `src/llm/ollama.js` - Ollama provider
- `src/llm/prompts.js` - RAG prompts

---

### POC 5: Memory (2 days)
**Goal:** Prove conversation context works

**Scope:**
- Store conversation history in SQLite
- Implement ACT-R activation/decay
- Bot remembers previous messages
- Export to memory.md (human-readable)

**Exit Criteria:**
1. User asks "What is X?" → Bot answers
2. User asks "What did I just ask?" → Bot replies "You asked about X"
3. User asks "What did I ask 2 days ago?" → Bot retrieves from decayed memory

**Files to create:**
- `src/memory/store.js` - SQLite wrapper
- `src/memory/actr.js` - ACT-R activation/decay
- `src/memory/sync.js` - Watch memory files, re-index
- `src/memory/export.js` - Export to memory.md

---

### POC 6: Daemon + Onboarding (2 days)
**Goal:** Prove installation works

**Scope:**
- `multis init` wizard (creates config, pairs with Telegram)
- `multis start` (starts daemon)
- `multis stop` (stops daemon)
- Auto-start on reboot (systemd/launchd)

**Exit Criteria:**
1. New user runs `multis init` → guided setup
2. `multis start` → daemon runs in background
3. Reboot machine → daemon auto-starts
4. `multis stop` → daemon stops cleanly

**Files to create:**
- `src/cli/init.js` - Onboarding wizard
- `src/cli/daemon.js` - Start/stop daemon
- `bin/multis.js` - CLI entry point
- `scripts/install-daemon.sh` - systemd/launchd setup

---

### POC 7: Multi-Platform Messaging (3-5 days)
**Goal:** Connect to WhatsApp, Signal, Discord via self-hosted Matrix

**Prerequisites:** POC4, POC5, POC6

**Scope:**
- Abstract transport layer (Telegram + Matrix)
- `multis setup matrix` provisions user's VPS with Synapse + mautrix bridges
- `/bridge <platform>` connects a platform via Telegram chat
- All messages from all platforms → same SQLite → same LLM

**Exit Criteria:**
1. `multis setup matrix` deploys Docker Compose stack to user's VPS via SSH
2. `/bridge whatsapp` → QR code sent via Telegram → WhatsApp linked
3. WhatsApp message → bot responds via WhatsApp
4. `/ask` works with context from any platform

**Full plan:** [MULTI_PLATFORM_PLAN.md](MULTI_PLATFORM_PLAN.md)

---

## Total Timeline

- POC 1: 1 day ✅
- POC 2: 1-2 days ✅
- POC 3: 2 days ✅
- POC 4: 1 day ← NEXT
- POC 5: 2 days
- POC 6: 2 days
- POC 7: 3-5 days

**Total: 12-16 days for full MVP with multi-platform**

---

## Dependencies

### Required (POC 1-6)
- `telegraf` - Telegram bot framework
- `better-sqlite3` - SQLite database
- `pdf-parse` - PDF parsing
- `mammoth` - DOCX parsing

### Required (POC 7)
- `matrix-bot-sdk` - Matrix client (already installed)
- `@matrix-org/matrix-sdk-crypto-nodejs` - E2EE (already installed)

### Optional (for later)
- `chokidar` - File watching (memory.md sync)
- `pm2` - Daemon process manager (alternative to systemd)

---

## Constraints

- ✅ Node.js vanilla (standard library first)
- ✅ No bloat or overengineering
- ✅ Each POC <500 lines of code
- ✅ Self-contained (works offline except LLM calls)
- ✅ Fast setup (<5 minutes from clone to running bot)
