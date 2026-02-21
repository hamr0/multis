# Changelog

All notable changes to multis. Pre-stable (0.x) — versions track feature milestones, not releases.

## [0.9.0] - 2026-02-21

### Added
- Beeper file indexing: send PDF/DOCX/MD/TXT via Note-to-self with `/index <scope>` to download and index
- Interactive scope prompt when no scope specified (reply 1 for public, 2 for admin)
- `BeeperPlatform.downloadAsset()` for Beeper Desktop API file downloads

### Fixed
- Removed stale DEBUG log from Beeper adapter

## [0.8.0] - 2026-02-20

### Fixed
- Beeper hibernate/sleep detection: re-seed seen messages after >30s poll gap
- Telegram stale message drop after sleep resume
- Skip business escalation when KB is empty — let LLM answer freely
- Save assistant replies on escalation and clarification paths to preserve conversation history

## [0.7.0] - 2026-02-19

### Added
- bare-agent integration: replaced custom LLM provider clients
- Agent loop via bare-agent `Loop` with configurable max rounds
- Retry with backoff on 429/5xx via bare-agent `Retry`
- Circuit breaker: shared per-process, opens after N failures
- Human checkpoints: yes/no approval before dangerous tool calls (e.g. `exec`)
- `/plan <goal>` command: breaks goals into steps, executes sequentially
- `/remind <duration> <action>` — one-shot reminders
- `/cron <expression> <action>` — recurring scheduled tasks
- `/jobs` — list active scheduled jobs
- `/cancel <id>` — cancel a scheduled job
- Scheduler persists to `~/.multis/data/scheduler.json`

### Removed
- `src/llm/client.js` — custom HTTP provider code replaced by bare-agent

## [0.6.0] - 2026-02-16

### Added
- Multi-agent personas: `config.agents` with per-agent persona and model
- Agent resolution: @mention → per-chat assignment → mode default → first agent
- `/agent`, `/agents` commands
- Tool-calling agent loop: LLM → tool_use → execute → loop (max 5 rounds)
- 24+ tool definitions: filesystem, shell, knowledge, desktop, Android/Termux
- Tool registry with platform + owner filtering via `tools.json`
- `recall_memory` tool with recency fallback for stopword queries
- `grep_files`, `find_files`, `send_file` tools
- Unified `/` command prefix across all platforms
- `/mode` interactive picker, search by name
- Telegram as admin for Beeper chats via platform registry
- Schema evolution: type/element/role fields on chunks

### Fixed
- Beeper triple-response: `Number()` on non-numeric IDs = NaN broke dedup → string Set
- `isOwner` broken for Beeper (Telegram ID vs Beeper senderId) → `msg.isSelf`
- Schema migration crash: CREATE INDEX before migration → reordered
- Double-stringified JSON in capture
- Removed `isSelf` PIN bypass

### Changed
- Beeper commands restricted to personal chats only
- Mode semantics clarified: off = ignore, silent = archive only, business = auto-respond

## [0.5.0] - 2026-02-11

### Added
- PIN auth: 4-6 digit, SHA-256 hashed, 24h timeout, 3-fail lockout
- Prompt injection detection with pattern matching + dedicated audit log
- Business escalation: 4-tier ladder (KB → clarify → escalate → human)
- Scoped search: SQL-level role filtering (`WHERE role IN (...)`)
- `/index` requires explicit `public` or `admin` scope — no silent defaults
- CLI menu: `multis init/start/stop/status/doctor`
- Init wizard with re-init skip-by-default, inline platform + LLM verification
- ACT-R activation decay: `ln(1 + sum)`, blended BM25 + activation scoring

## [0.4.0] - 2026-02-11

### Added
- Per-chat memory: ChatMemoryManager with profile.json, recent.json, memory.md, daily logs
- LLM-summarized capture when rolling window overflows
- `generateWithMessages()` on all LLM providers
- `buildMemorySystemPrompt()` — composes memory + RAG chunks
- `/memory`, `/remember`, `/forget` commands
- Admin identity aggregation: shared `admin/memory.md` across platforms

## [0.3.0] - 2026-02-10

### Added
- LLM RAG pipeline: FTS5 search → buildRAGPrompt → LLM → answer with citations
- Per-provider system prompt handling (Anthropic/Ollama use body.system, OpenAI uses role message)
- Chat modes: personal/business per chat, persisted to config
- Natural language routing: plain text → implicit `/ask`
- Beeper: self-chat → natural language, business chats → auto-respond

## [0.2.0] - 2026-02-09

### Added
- Platform abstraction: base class + Telegram/Beeper adapters
- Normalized Message class with cross-platform command parsing
- Beeper Desktop API integration (polling, token auth, `setup-beeper.js`)
- Document indexing: PDF, DOCX, MD, TXT parsers
- Hierarchical section-based chunking (2000ch, 200 overlap, sentence boundaries)
- SQLite FTS5 store with BM25 search
- `/index`, `/search`, `/docs` commands + Telegram file upload

## [0.1.0] - 2026-02-09

### Added
- Telegram echo bot with Telegraf
- Pairing code auth (deep link + manual `/start`)
- `/exec`, `/read`, `/skills`, `/help` commands
- Governance: command allowlist/denylist + path restrictions
- Audit logging to `~/.multis/audit.log`
- Owner model: first paired user = owner
- Config: `.env` + `~/.multis/config.json`
- npm name reserved: `multis@0.1.0`
