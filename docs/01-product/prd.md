# multis — POC Roadmap

**Goal:** A personal and business AI agent that lives in your chat apps. Runs locally, indexes your documents, remembers conversations, auto-responds when you want it to.

---

## POC 1: Telegram Echo Bot — Done (a889fe5)

**Goal:** Prove bot connection works.

**What was built:**
- Telegraf bot with pairing code authentication
- Deep link support: `t.me/multis02bot?start=<code>`
- Echo handler for all text messages
- Config: `.env` + `~/.multis/config.json` (auto-created from template)

**Findings:**
- Telegraf `bot.on('text')` fires for ALL messages including `/command` — must filter with `text.startsWith('/')`
- `ctx.startPayload` gives deep link param directly, not `ctx.message.text`

---

## POC 2: Basic Skills — Done (63e0da3)

**Goal:** Prove personal assistant use case.

**What was built:**
- `/exec` — run allowlisted shell commands
- `/read` — read files and directories
- `/skills`, `/help` — discovery commands
- Governance layer: allowlist/denylist in `governance.json` + path restrictions
- Audit log: append-only JSONL at `~/.multis/audit.log`
- Owner model: first paired user becomes owner, `/exec` + `/index` restricted to owner

**Findings:**
- Governance JSON is simple and effective — no need for a complex policy engine
- Owner model covers the single-user case well, scales to "owner + trusted users" later

---

## POC 3: Document Indexing — Done (7ece1c2)

**Goal:** Prove document retrieval works (no LLM yet).

**What was built:**
- Parsers: PDF (pdfjs-dist), DOCX (mammoth), MD, TXT
- Hierarchical section-based chunking: 2000 chars, 200 overlap, sentence-boundary-aware
- SQLite store with FTS5 for BM25 search
- Activation columns pre-built for ACT-R: `base_activation`, `last_accessed`, `access_count`
- Query tokenization: stopword removal + OR joining for FTS5 MATCH
- Commands: `/index <path>`, `/search <query>`, `/docs`
- Telegram file upload → download + index automatically

**Findings:**
- Aurora's Python pipeline adapted well to Node.js — concept-port, not line-by-line translation
- FTS5 built-in BM25 ranking replaces Aurora's custom BM25 scorer entirely
- Section path preservation (heading hierarchy as JSON array) is key for good citations

---

## POC 4: LLM RAG + Chat Modes — Done (764e325)

**Goal:** Search docs → LLM → answer with citations. Add chat modes for Beeper.

**What was built:**
- RAG pipeline: `routeAsk` → FTS5 search (top 5) → `buildRAGPrompt` → LLM → answer
- All three LLM providers fixed for native `options.system` support (Anthropic, OpenAI, Ollama)
- Plain text treated as implicit `/ask` (Telegram + Beeper personal chats)
- Chat modes: `/mode personal` (ignore incoming) vs `/mode business` (auto-respond)
- Per-chat mode persisted to `config.platforms.beeper.chat_modes[chatId]`
- Beeper self-chat detection + natural language routing via `msg.routeAs`

**Validated:** 2026-02-10 — live Anthropic API (Haiku 4.5), full router path (not just LLM client). Tested: `/ask`, natural language routing, RAG prompt builder with citations, `/mode`, auth blocking, `/help`.

**Findings:**
- Platform abstraction (done early in POC7 partial) made this easy — router doesn't care about source
- Chat modes solve the "Beeper sees all chats" problem — user controls which chats are active
- Provider hostnames are hardcoded — OpenAI provider can't reach GLM/Groq/Together/vLLM. Needs `baseUrl` option (polish pass)

---

## POC 7 (partial): Platform Abstraction — Done (ad98ec8)

**Goal:** Abstract transport so the same router handles Telegram and Beeper.

**What was built:**
- `Platform` base class: `start()`, `stop()`, `send()`, `onMessage()`
- `Message` class: normalized across platforms with `isCommand()`, `parseCommand()`, `routeAs`
- Telegram adapter: wraps Telegraf, creates Message objects
- Beeper adapter: polls `localhost:23373`, token auth, self-message detection
- `setup-beeper.js`: token setup wizard
- Platform-agnostic router in `handlers.js` replaces per-platform handlers

**Findings:**
- Beeper E2EE is a dead end for bots — Desktop localhost API bypasses it
- `/` prefix unified across platforms — commands restricted to personal/Note-to-self chats on Beeper
- Polling at 3s is fast enough, not wasteful

**TODO (polish pass or POC6):** On server startup, check if Beeper Desktop is running (hit `localhost:23373`). If not reachable, log warning and disable Beeper gracefully — don't crash. Re-check periodically.

---

## POC 5: Memory + Per-Chat Profiles — Next

**Goal:** Per-chat conversation memory with rolling context, LLM-driven summarization, and activation decay.

### Design

Every chat gets its own isolated profile. No global memory — everything is per-chat.

**Storage layout:**
```
~/.multis/memory/chats/<chatId>/
├── profile.json      # mode, preferences, metadata
├── recent.json       # rolling window (last N messages)
├── memory.md         # LLM-summarized durable notes for THIS chat
└── log/
    └── 2026-02-10.md # raw daily append-only log
```

**Per-chat profile (`profile.json`):**
```json
{
  "mode": "personal",
  "chatName": "Alice",
  "platform": "beeper",
  "lastActive": "2026-02-10T14:30:00Z",
  "preferences": {}
}
```

**Rolling window (`recent.json`):**
- Last N messages (configurable, default ~20)
- Fed to LLM as conversation context on every call
- When window overflows: trigger capture cycle

**Chat memory (`memory.md`):**
- LLM-summarized durable notes — decisions, facts, preferences, action items
- Loaded into system prompt for this chat's LLM calls
- Written by the capture skill (see below), not by hand

**Daily log (`log/YYYY-MM-DD.md`):**
- Raw append-only log of all messages
- Searchable via indexer (pushed to FTS5 with activation decay)
- Human-readable backup

### Capture Cycle (Cron Job)

A periodic job runs for each chat with activity:

```
1. Read recent.json (rolling window)
2. Run LLM with capture skill → "extract what matters"
3. Append output to memory.md for that chat
4. Push full raw messages to indexer (searchable with decay)
5. Trim recent.json back to last N messages
```

**The capture skill (`skills/capture.md`) is human-written** — it tells the LLM what to extract. Users can customize it per use case (personal vs business).

### ACT-R Activation Decay

Applied to indexed conversation chunks (same as document chunks):
- `base_activation` — set when chunk is created
- `access_count` — bumped when chunk is retrieved via search
- `last_accessed` — updated on access
- Decay formula: `activation = base + ln(access_count) - decay_rate * age`
- Recent + frequently-accessed chunks rank higher in search results
- Old untouched chunks fade away naturally

### Memory in LLM Calls

For each LLM call in a chat:
```
System prompt:
  - Base prompt (you are multis...)
  - Chat memory.md (durable notes for this chat)
  - RAG chunks (if /ask with document search)

User messages:
  - Recent window (last N messages as conversation history)
  - Current message
```

### Commands
- `/memory` — show this chat's memory.md
- `/forget` — clear this chat's memory (keeps logs)
- `/remember <note>` — manually add a note to memory.md

### What This Borrows

| Source | What | Our twist |
|--------|------|-----------|
| openclaw | memory.md durable notes | Per-chat, not global |
| openclaw | Daily log files | Same pattern |
| openclaw | Pre-compaction flush | Our capture skill + cron |
| Aurora | ACT-R activation decay | Applied to conversation chunks |
| Aurora | SQLite FTS5 indexing | Same store, conversation + documents |

---

## POC 6: Daemon + CLI + Cron

**Goal:** Installation wizard, daemon lifecycle, scheduled jobs.

### Daemon
- `multis init` — onboarding wizard: choose personal or business (sets `default_mode`), configure Telegram token, optional LLM API key, optional Beeper setup
- `multis start` — start daemon (background process)
- `multis stop` — stop daemon
- Auto-start on reboot (systemd unit on Linux, launchd plist on macOS)

### Cron Scheduler
Built-in job scheduler (inspired by openclaw's cron system):

**Core jobs:**
- **Capture cycle** — runs every N minutes for chats with new activity. Summarize → memory.md → index → trim.
- **Activation decay** — periodic recalculation of activation scores (or on-access, TBD)

**User-defined jobs (later):**
- Morning brief: "Summarize what happened overnight across all business chats"
- Reminders: "Remind me to follow up with Alice in 2 hours"
- Digest: "Weekly summary of all customer conversations"

**Storage:** `~/.multis/cron/jobs.json` (same pattern as openclaw)

### Onboarding Flow
```
$ multis init

Welcome to multis!

What's your primary use? [personal / business]
> personal

Setting default mode: personal
(You can switch any chat to business later with /mode business)

Telegram bot token (from @BotFather):
> ****

LLM provider? [anthropic / openai / ollama / skip]
> anthropic

API key:
> ****

Connect Beeper Desktop? [y/N]
> n

Config saved to ~/.multis/config.json
Pairing code: F71A9B

Start the bot: multis start
Then send /start F71A9B to @multis02bot on Telegram
```

---

## POC 7: Multi-Platform (Full)

**Goal:** Complete Beeper + Matrix integration.

**Three paths (use what you have):**
1. **Telegram** (mandatory, zero infra) — always available
2. **Beeper Desktop API** (optional, requires Desktop running) — all bridges via localhost
3. **Self-hosted Matrix** (optional, requires VPS) — Synapse + mautrix bridges, $5-10/month

Platform abstraction already done. Remaining work:
- Matrix client adapter (for Path 3)
- `multis setup matrix` — deploy Docker Compose to VPS via SSH
- Bridge management commands: `/bridge whatsapp`, `/bridge status`
- Cross-platform context: "What did Alice say on WhatsApp yesterday?"

See [multi-platform.md](../02-features/multi-platform.md) for full design.

---

## Timeline

| POC | Estimate | Status |
|-----|----------|--------|
| 1 | 1 day | Done |
| 2 | 1-2 days | Done |
| 3 | 2 days | Done |
| 4 | 1 day | Done |
| 7 (partial) | 1 day | Done (platform abstraction) |
| 5 | 2-3 days | Next |
| 6 | 2 days | Planned |
| 7 (full) | 3-5 days | Planned |

---

## Dependencies

| Package | Purpose | POC |
|---------|---------|-----|
| `telegraf` | Telegram bot | 1+ |
| `better-sqlite3` | SQLite + FTS5 | 3+ |
| `pdfjs-dist` | PDF parsing (TOC + per-page) | 3+ |
| `mammoth` | DOCX parsing | 3+ |

No new dependencies expected for POC 5-6. POC 7 (full) may need Matrix SDK.
