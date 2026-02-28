# Changelog

All notable changes to multis. Pre-stable (0.x) — versions track feature milestones, not releases.

## [0.11.2] - 2026-02-28

### Added
- `/mode business` unified menu — replaces `/business` command with 5-option menu (setup, show, clear, global default, assign chats)
- Wizard skip/clear support — re-running wizard shows current values, "skip" preserves them, "clear" resets topics/rules
- Single-line topic format — "Topic: Description" instead of 2-message flow
- Step headers in wizard (Step 1/5 — Name, etc.)
- Emoji/short message guard — emoji-only messages in business chats are silently ignored (no "Usage: /ask" leak)

### Removed
- `/business` command — all functionality moved to `/mode business` menu

### Changed
- Wizard pre-populates from existing `config.business` values
- "Topic: Description" single-line format replaces the 2-step name+description flow

## [0.11.1] - 2026-02-27

### Fixed
- `/mode` picker replies silently dropped — personal/Note-to-self chat defaulted to `off` mode, which allowed `/commands` but blocked non-command replies like picker selections
- `_pendingMode` keyed by `chatId` instead of `senderId` — Beeper senderId can vary across messages from the same user
- `/mode` picker now loops properly: digits select, `/commands` cancel, other text prompts user to pick a number

### Changed
- Personal/Note-to-self chats default to `personal` mode (never restricted) — they are admin command channels
- `/mode` read-only listing now shows numbered entries on both Telegram and Beeper

## [0.11.0] - 2026-02-23

### Added
- `config.chats` as single source of truth for chat metadata (name, network, platform, mode, lastActive)
- `escalate` tool: LLM-driven escalation — sends notifications to ALL admin channels (Telegram + Beeper Note-to-self) automatically, no config needed
- `getAdminChatIds()` on BeeperPlatform — exposes self/note-to-self chats for admin notifications
- Admin presence pause: owner typing in business chat pauses bot for configurable duration (default 30min)
- `/business setup` wizard: input validation (name 2-100 chars, greeting max 500, topics/rules max 200)
- Config backup: `config.json.bak` created before Beeper API discovery writes
- `updateChatMeta()` for upserting chat entries into config.chats
- `platformRegistry` passed to all tool ctx objects (routeAsk, scheduler tick, plan steps)

### Changed
- Business escalation: replaced keyword short-circuit with LLM-driven escalation via `escalate` tool — all business messages now flow through LLM
- Escalation notifications auto-resolve admin channels from platform registry (Telegram owner_id + Beeper self-chats) — `admin_chat` config is optional override only
- `/business setup` wizard: `/commands` typed during wizard now cancel and re-route (no longer swallowed as input)
- `setChatMode()` / `getChatMode()` read/write from `config.chats[chatId].mode` instead of `config.platforms.beeper.chat_modes`
- `listBeeperChats()` reads from `config.chats` (no Beeper API call needed)
- `findBeeperChat()` searches `config.chats` first, falls back to Beeper API for unknown chats
- `buildBusinessPrompt()` escalation guidance rewritten: LLM uses escalate tool, responds naturally and empathetically

### Removed
- `profile.json` per-chat files: `loadProfile()`, `saveProfile()`, `updateProfile()`, `profilePath` removed from ChatMemoryManager
- Keyword short-circuit block in business routing (replaced by LLM + escalate tool)
- `admin_chat` wizard step (auto-resolved from platform registry instead)

### Fixed
- Admin pause: nullish coalescing (`??`) instead of OR (`||`) for `admin_pause_minutes` — 0 is now valid
- Business routing missing `platformRegistry` in toolDeps — escalate tool silently failed to send notifications

## [0.10.0] - 2026-02-23

### Added
- Two-stage memory pipeline: recent → memory.md (stage 1) → DB condensation (stage 2)
- Silent mode capture: silent chats now trigger memory summarization pipeline
- Chat metadata persistence: displayName, network saved to profile.json
- `runCondenseMemory()` for stage 2 memory condensation
- `countMemorySections()` and `updateProfile()` on ChatMemoryManager
- `network` field on normalized Message class

### Changed
- Capture threshold from 20 → 10 messages (was already default, now explicit)
- Off mode is strict zero-I/O: no logs, no recent, no memory
- Personal/note-to-self chats can no longer be set to silent or off
- Off-mode self messages that aren't commands are now skipped in Beeper

### Fixed
- Silent mode chats never triggered capture despite accumulating messages

## [0.9.0] - 2026-02-21

### Added
- Beeper file indexing: send PDF/DOCX/MD/TXT via Note-to-self with `/index <scope>` to download and index
- Interactive scope prompt when no scope specified (reply 1 for public, 2 for admin)
- `BeeperPlatform.downloadAsset()` for Beeper Desktop API file downloads
- `/business setup|show|clear` command with conversational wizard for configuring business persona
- `buildBusinessPrompt()` compiles structured config (name, greeting, topics, rules, allowed_urls) into system prompt
- Business mode LLM always responds — no more canned "rephrase" messages on 0 KB matches
- `allowed_urls` field in business config for reference links in customer responses

### Changed
- Removed retry-based escalation (`max_retries_before_escalate`, `escalationRetries` Map)
- Keyword escalation still works — "refund", "complaint" etc. fast-track to admin
- `admin_chat` moved into `escalation` sub-object (legacy location still migrated)

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
