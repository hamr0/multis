# Implementation Log

## 2026-02-09: POC1 — Telegram Echo Bot (a889fe5)
- Telegraf bot with pairing code auth
- Deep link + manual `/start` pairing
- Echo handler for all text messages
- Config: `.env` + `~/.multis/config.json`

## 2026-02-09: POC2 — Basic Skills (63e0da3)
- `/exec`, `/read`, `/skills`, `/help` commands
- Governance enforcement: allowlist/denylist/path restrictions
- All actions audit logged to `~/.multis/audit.log`
- Owner model: first paired user = owner, `/exec` + `/index` restricted

## 2026-02-09: POC3 — Document Indexing (7ece1c2)
- Ported aurora_context_doc pipeline to Node.js
- PDF (pdf-parse), DOCX (mammoth), MD, TXT parsers
- Hierarchical section-based chunking (2000ch, 200 overlap, sentence boundaries)
- SQLite store with FTS5 for BM25 search
- Activation columns pre-built for ACT-R (POC5)
- Natural language query tokenization with stopword removal + OR joining
- `/index`, `/search`, `/docs` commands + Telegram file upload

## 2026-02-09: POC7 (partial) — Platform Abstraction (ad98ec8)
- Platform abstract class + Telegram/Beeper adapters
- Normalized Message class with cross-platform command parsing
- Beeper Desktop API integration (polling, token auth)
- `//` command prefix for Beeper self-messages
- Platform-agnostic message router in handlers.js
- `setup-beeper.js` token setup wizard

## 2026-02-10: POC4 — LLM RAG + Chat Modes
- Fixed all LLM providers: `options.system` with native per-provider handling
- Created `buildRAGPrompt()` — formats search chunks with source metadata
- `routeAsk`: search → prompt → LLM → answer with citations
- `routeMode`: set chat to personal/business, persisted to config
- Natural language routing: plain text in Telegram → implicit ask
- Beeper: self-chat detection, personal chat → natural language, business → auto-respond
- Added `routeAs` property to Message class

## 2026-02-11: POC5 — Per-Chat Memory
- ChatMemoryManager: per-chat file I/O (profile.json, recent.json, memory.md, daily logs)
- Capture: LLM-summarized durable notes when rolling window overflows
- `generateWithMessages()` on all LLM providers (Anthropic, OpenAI, Ollama)
- `buildMemorySystemPrompt()` — composes memory.md + RAG chunks into system prompt
- Commands: `/memory`, `/remember`, `/forget`
- Admin identity aggregation: shared `admin/memory.md` across platforms

## 2026-02-11: POC6 — Daemon + CLI + Security
- PIN auth: 4-6 digit, SHA-256 hashed, 24h timeout, 3-fail lockout
- Prompt injection detection: pattern matching + dedicated audit log
- Business escalation: 4-tier ladder (KB → clarify → escalate → human)
- Scoped search: SQL-level role filtering (`WHERE role IN (...)`)
- `/index` requires explicit `public` or `admin` scope — no silent defaults
- CLI menu: `multis init/start/stop/status/doctor`
- Init wizard with re-init skip-by-default, inline platform + LLM verification
- ACT-R activation decay: `ln(1 + Σ t_j^-0.5)`, blended BM25 + activation scoring
- 202 tests passing

## 2026-02-15: Multi-Agent + Tool Calling
- Multi-agent personas: `config.agents` with persona, model per agent
- Agent resolution: @mention → per-chat assignment → mode default → first agent
- `/agent`, `/agents` commands
- Tool-calling agent loop: LLM → tool_use → execute → loop (max 5 rounds)
- 24+ tool definitions: filesystem, shell, knowledge, desktop, Android/Termux
- Tool registry: platform + owner filtering via `tools.json`
- `recall_memory` tool with recency fallback for stopword queries
- Schema evolution: type/element/role fields on chunks
- `grep_files`, `find_files`, `send_file` tools
- Unified `/` command prefix across all platforms
- `/mode` interactive picker, search by name, Telegram as admin for Beeper chats
- Platform registry: cross-platform operations via `registerPlatform()`

## 2026-02-16: Dogfooding Fixes
- Beeper triple-response: `Number()` on non-numeric IDs = NaN, broke dedup → fixed with string Set
- `isOwner` broken for Beeper (Telegram ID vs Beeper senderId) → fixed with `msg.isSelf`
- Schema migration crash: CREATE INDEX before migration → reordered
- Beeper commands restricted to personal chats only
- Removed `isSelf` PIN bypass
- Mode semantics clarified: off = ignore, silent = archive only, business = auto-respond
- Double-stringified JSON in capture → fixed

## 2026-02-19: bare-agent Migration (69bf28e)
- Replaced custom LLM provider clients with bare-agent library
- `src/llm/provider-adapter.js`: thin factory mapping config → bare-agent providers
- Agent loop: bare-agent `Loop` with `Retry` and `CircuitBreaker`
- Human checkpoints: bare-agent `Checkpoint` → yes/no approval before dangerous tools
- Planner: bare-agent `Planner` → `/plan <goal>` breaks into steps, executes sequentially
- Scheduler: bare-agent `Scheduler` → `/remind`, `/cron`, `/jobs`, `/cancel` commands
- Removed `src/llm/client.js` (custom HTTP provider code)
- All 344 tests passing

## 2026-02-20: Stability Fixes
- Beeper hibernate/sleep detection: re-seed `_seen` set after >30s poll gap (dbbd804)
- Telegram stale message drop after sleep resume (d44b53a)
- Skip escalation when KB is empty — let LLM answer freely (a58416b)
- Save assistant replies on escalation/clarification paths to preserve conversation history

## 2026-02-21: Beeper File Indexing (dbb4cd1)
- Admin sends file (PDF/DOCX/MD/TXT) via Beeper Note-to-self with `/index <scope>`
- Bot downloads via `POST /v1/assets/download`, indexes locally
- Interactive scope prompt if not specified: "Reply 1 (public) or 2 (admin)"
- `BeeperPlatform.downloadAsset()` method, `_attachments` on normalized Message
- Removed DEBUG log from beeper.js
- 6 new integration tests, 344 total passing
