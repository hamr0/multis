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

### POC 6: Daemon + CLI + Security + Data Isolation (3-4 days)
**Goal:** Production-ready daemon with auth, data isolation, escalation, and cleanup

**Full design:** `docs/00-context/blueprint.md` (sections 5-13)

**Scope:**
- `multis init` wizard (config, Telegram, LLM, PIN, Beeper optional)
- `multis start/stop/status` (daemon with PID file, systemd)
- PIN authentication (4-6 digit, 24h timeout, lockout after 3 fails)
- Chunk scoping (`scope` column: `kb`, `admin`, `user:<chatId>`)
- `/index <path> kb|admin` (must specify scope, bot asks if missing)
- Hard SQL scope filtering on all searches (customers only see `kb` + own history)
- Prompt injection defense (pattern detection + `prompt_injection_audit.log`)
- Memory.md pruning (keep last N sections, old summaries already in FTS)
- FTS retention cleanup (90d default, admin 365d)
- Log cleanup (30d auto-clean on startup + daily)
- Admin identity aggregation (shared `admin/memory.md` across platforms)
- Business-mode escalation (4-tier: KB → URLs → Clarify → Human)
- Customer reminders forwarded as notes to admin (no customer self-serve cron)
- Admin-only cron (`/remind`, `/cron`)
- All settings configurable via `config.json` with sane defaults

**Exit Criteria:**
1. `multis init` → guided setup, PIN set, config created
2. `multis start` → daemon runs in background, platforms connect
3. `multis stop` → graceful shutdown
4. Owner command after 24h → bot asks for PIN before executing
5. `/index ~/docs/faq.pdf kb` → chunks stored with `scope=kb`
6. `/index ~/docs/private.pdf admin` → chunks stored with `scope=admin`
7. `/index ~/docs/file.pdf` (no scope) → bot asks "Label as kb or admin?"
8. Customer in business-mode asks question → only sees `kb` + own history
9. Customer tries prompt injection → flagged in `prompt_injection_audit.log`
10. Capture fires → summary appended to memory.md + indexed in FTS → memory.md pruned to last 5 sections
11. Old logs (>30d) auto-cleaned on startup
12. Customer asks unanswerable question → escalated to admin via `admin_chat`
13. Reboot → daemon auto-starts (systemd)

**Files to create/modify:**
- `bin/multis.js` - CLI entry point (`init`, `start`, `stop`, `status`)
- `src/cli/init.js` - Onboarding wizard (PIN, config, platform setup)
- `src/cli/daemon.js` - Daemon lifecycle (PID file, fork, shutdown)
- `src/security/pin.js` - PIN hash/verify, session tracking, lockout
- `src/security/injection.js` - Prompt injection pattern detection + audit
- `src/indexer/store.js` - Add `scope` column, scoped search
- `src/bot/handlers.js` - `/index` scope arg, PIN check on owner commands, escalation routing
- `src/memory/capture.js` - Scoped indexing, memory.md pruning
- `src/memory/manager.js` - Admin memory aggregation, log cleanup
- `src/cron/scheduler.js` - Cleanup jobs, admin reminders
- `src/cron/jobs.js` - Job storage + execution
- `skills/admin.md` - Admin policy skill
- `skills/customer-support.md` - Customer policy skill
- `scripts/multis.service` - systemd unit file

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

### Optional: Phone Control (deferred)
**Goal:** Control Android/iOS phone from multis or run multis on the phone

**Android (Termux — full control):**
- Termux + Node.js runs multis natively on the phone
- `termux-api` package exposes phone hardware as shell commands:
  - SMS: `termux-sms-send -n <number> <message>`
  - Camera: `termux-camera-photo <path>`
  - Notifications: `termux-notification --title <t> --content <c>`
  - Clipboard: `termux-clipboard-set <text>`, `termux-clipboard-get`
  - Location: `termux-location`
  - TTS: `termux-tts-speak <text>`
  - Volume, vibrate, battery status, Wi-Fi scan, media player
- multis `/exec` already handles these — no new code needed on the phone
- Background service via `termux-wake-lock` (OEM battery killers are the main risk)

**Remote phone agent (Android → laptop):**
- Lightweight Termux agent (~50 lines Node.js) on the phone
- Connects back to laptop multis via reverse SSH tunnel or MQTT
- Receives commands from laptop, executes `termux-api` calls, returns results
- Enables "send SMS from laptop" / "take photo from laptop" workflows

**iOS (interface-only):**
- No native Node.js runtime — cannot run multis on device
- Interface via Telegram already works (phone → Telegram → laptop multis → response)
- Limited automation via Shortcuts app + webhook triggers (ntfy.sh/Pushover)
  - Laptop multis sends HTTP to ntfy.sh → iOS Shortcut picks up → executes action
  - Works for notifications, simple automations; no camera/SMS/clipboard access

**Cross-platform fallback (both iOS/Android):**
- Webhook triggers: ntfy.sh or Pushover → Tasker (Android) / Shortcuts (iOS)
- No code running on phone, limited to what the automation app supports
- Good for notifications and simple triggers, not full control

**Status:** Skipped for now. Revisit after POC7 (multi-platform). Android via Termux is the only real path for full phone control.

---

## Total Timeline

- POC 1: 1 day ✅
- POC 2: 1-2 days ✅
- POC 3: 2 days ✅
- POC 4: 1 day ✅
- POC 5: 2 days ✅
- POC 6: 3-4 days ← NEXT (daemon + CLI + security + data isolation)
- POC 7: 3-5 days
- Optional: Phone control (deferred)

**Total: 13-18 days for full MVP with multi-platform**

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
