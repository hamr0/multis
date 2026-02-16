# Roadmap: Post-POC

> POC 1-6 complete. All 300 tests passing. Next: dogfood, stabilize, ship.

## What's Built (POC 1-6 Summary)

| POC | What | Key Files |
|-----|------|-----------|
| 1 | Telegram echo bot, pairing flow | `src/platforms/telegram.js`, `src/bot/handlers.js` |
| 2 | Skills (exec, read), governance allowlist/audit | `src/skills/executor.js`, `src/governance/` |
| 3 | Document indexing (PDF, DOCX, MD, TXT), FTS5 | `src/indexer/`, `src/indexer/store.js` |
| 4 | LLM RAG (Anthropic, OpenAI, Ollama), multi-provider | `src/llm/`, `src/llm/prompts.js` |
| 5 | Per-chat memory, capture, rolling window, memory.md | `src/memory/manager.js`, `src/memory/capture.js` |
| 6 | Security + CLI + tools + cleanup (see below) | `src/security/`, `src/tools/`, `src/maintenance/`, `bin/multis.js` |

### POC6 Components

- **PIN auth**: 4-6 digit, SHA-256 hashed, 24h timeout, 3-fail lockout (`src/security/pin.js`)
- **Prompt injection detection**: pattern matching + dedicated audit log (`src/security/injection.js`)
- **Scoped search**: SQL-enforced `WHERE scope IN (...)` — kb, admin, user:chatId
- **Business escalation**: 4-tier (KB → clarify → escalate → human) in routeAsk
- **Retention cleanup**: log cleanup (30d) + FTS pruning (90d user, 365d admin), runs on startup + daily (`src/maintenance/cleanup.js`)
- **Tool-calling agent loop**: LLM executes actions via tools, multi-round (`src/tools/`, `src/bot/handlers.js:runAgentLoop`)
- **Tools**: exec, read_file, send_file, grep_files, find_files, search_docs, recall_memory, remember, open_url, media_control, notify, clipboard, screenshot, system_info, wifi, brightness + Android tools
- **Hallucination guardrail**: system prompt explicitly constrains bot to tool-only capabilities (`src/llm/prompts.js`)
- **Multi-agent personas**: per-chat assignment, @mention routing, mode+agent combo (`config.agents`)
- **CLI**: `multis init/start/stop/status/doctor/logs` + interactive menu (`bin/multis.js`)
- **Cross-platform governance**: flat allowlist covering Linux, macOS, Windows, Android

---

## Phase A: Dogfood & Stabilize (current)

Use multis daily for a week. Fix what breaks. Build confidence before sharing.

### A1. Fresh Onboarding Test

Start from scratch as if you're a new user. Validates the full install → first-use path.

- [ ] `rm -rf ~/.multis` (clean slate)
- [ ] `npm install` from repo root
- [ ] `node bin/multis.js init` — complete the wizard
  - [ ] Platform selection (Telegram / Beeper / Both)?
  - [ ] Bot mode (personal / business)?
  - [ ] Telegram token → verified? Bot username shown?
  - [ ] Inline pairing → sent /start → paired as owner?
  - [ ] LLM provider → key verified with real API call?
  - [ ] PIN set?
  - [ ] Summary shows all verified components?
  - [ ] `~/.multis/config.json` created with correct values?
  - [ ] `owner_id` set from inline pairing?
- [ ] `node bin/multis.js start` — does the daemon start?
- [ ] `node bin/multis.js status` — shows running PID?
- [ ] `node bin/multis.js doctor` — all checks pass?
  - [ ] LLM check does real verification (not just key presence)?

### A2. Telegram End-to-End

- [ ] Open bot on Telegram
- [ ] Already paired from init? (no `/start <code>` needed)
- [ ] `/status` — shows `Role: owner`?
- [ ] `/help` — shows owner commands (exec, read, index, pin, mode)?
- [ ] `/exec ls ~` — triggers PIN prompt? Enter PIN → output?
- [ ] `/exec echo hello` — governance allows it?
- [ ] `/mode` (no args) — shows current chat mode?
- [ ] `/mode personal` — sets mode (no PIN needed, mode removed from PIN_PROTECTED)?
- [ ] `/read ~/.multis/config.json` — shows file content?
- [ ] Upload a PDF file — auto-indexed? Reports chunk count?
- [ ] `/index ~/some-real-doc.pdf kb` — indexes with scope?
- [ ] `/search <term from that doc>` — finds relevant chunks?
- [ ] `/ask <question about that doc>` — LLM answers with citations?
- [ ] `/docs` — shows correct stats?
- [ ] Send 20+ messages → does memory capture trigger?
- [ ] `/memory` — shows captured notes?
- [ ] `/remember always use dark mode` — saved?
- [ ] `/memory` — shows the note?
- [ ] `/forget` — clears memory?

### A3. Tool Calling Tests

- [ ] "What time is it?" → uses exec tool (date command), not hallucinated answer?
- [ ] "Open YouTube" → uses open_url tool?
- [ ] "Find blueprint.md" → uses find_files tool?
- [ ] "Search for 'retention' in my project" → uses grep_files tool?
- [ ] "Send me the config file" → uses send_file tool?
- [ ] "Take a screenshot" → uses screenshot tool?
- [ ] "Set a reminder for tomorrow" → **refuses honestly** (no reminder tool), suggests /remember?
- [ ] "Send an email to John" → **refuses honestly** (no email tool)?
- [ ] "What's my battery status?" → uses system_info tool?
- [ ] "Pause the music" → uses media_control tool?

### A4. Beeper End-to-End

- [ ] `node src/cli/setup-beeper.js` — OAuth flow works?
- [ ] Beeper Desktop running with API enabled?
- [ ] `node bin/multis.js start` — Beeper connects, shows account count?
- [ ] Send `/status` from Note-to-self — responds?
- [ ] Send `/help` — shows commands?
- [ ] Type a question in Note-to-self (no `/`) — implicit ask works?
- [ ] `/exec ls ~` from Note-to-self — PIN → output?
- [ ] `/search <term>` — finds docs?
- [ ] `/status` from a friend chat — silently ignored (not routed as command)?

#### Mode tests (Beeper)

- [ ] `/mode` (no args) from Note-to-self → lists all chats with current modes (no PIN)?
- [ ] `/mode business` from Note-to-self → interactive picker? Pick a chat → set?
- [ ] `/mode silent John` from Note-to-self → search by name → set?
- [ ] `/mode business` in a non-self chat → silently ignored (commands restricted to personal chats)?
- [ ] Send message from contact in business-mode chat → auto-responds?
- [ ] Send message from friend in silent-mode chat → archived but no response?

### A5. Multi-Agent

- [ ] Add second agent to config.json (e.g. "coder" with different persona)
- [ ] `multis doctor` — shows agent count, defaults validated?
- [ ] `/agents` — lists all agents with persona preview?
- [ ] Send plain message — responds as default agent?
- [ ] `@coder how do I parse JSON?` — responds with [coder] prefix?
- [ ] `/agent coder` — assigns coder to current chat?
- [ ] Send plain message — responds as coder (sticky)?
- [ ] `/agent` (no args) — shows current agent?
- [ ] `/agent assistant` — switches back?
- [ ] `/mode personal coder` — sets both mode and agent?
- [ ] `@nonexistent hello` — treated as plain text, default agent responds?
- [ ] Remove `agents` from config.json — bot starts normally, no crash?
- [ ] Malform `agents` (e.g. `"agents": 123`) — bot starts with warning?
- [ ] Agent missing `persona` field — skipped with warning, doctor reports it?
- [ ] `defaults.business` points to nonexistent agent — doctor warns, fallback works?

### A6. Edge Cases & Error Handling

- [ ] `/exec rm -rf /` — governance blocks it?
- [ ] `/index /nonexistent/path kb` — error message, not crash?
- [ ] `/index ~/file.pdf` (no scope) — asks for scope?
- [ ] Upload unsupported file (.xlsx, .jpg) — graceful error?
- [ ] Wrong PIN 3 times — lockout message?
- [ ] Send very long message (>4000 chars) — doesn't crash?
- [ ] Kill daemon, run `multis status` — says "not running", cleans stale PID?
- [ ] Run `multis start` twice — second one says already running?
- [ ] No LLM API key set — `/ask` gives helpful error?
- [ ] No internet — bot stays alive, reconnects?
- [ ] Non-owner tries `/mode business` — rejected?
- [ ] Non-owner tries `/exec` — rejected?

### A7. Memory & Retention

- [ ] Chat for 20+ messages → capture triggers automatically?
- [ ] `/memory` shows LLM-summarized notes (not raw messages)?
- [ ] `/remember my wife's name is Sarah` → saved to memory.md?
- [ ] New session: "what's my wife's name?" → recall_memory finds it?
- [ ] "What did we talk about last?" → recency fallback works (not empty)?
- [ ] Check `~/.multis/memory/chats/<id>/log/` — daily logs exist?
- [ ] Logs older than 30 days cleaned on startup? (create a fake old log to test)
- [ ] Admin memory chunks survive past 90 days? (365-day retention)

### A8. Bug & Friction Log

Keep a running list here as you test. Each entry: what happened, expected vs actual.

| # | Area | Issue | Severity | Status |
|---|------|-------|----------|--------|
| 1 | LLM | Bot hallucinated "reminder set" — no reminder system exists | High | Fixed (guardrail added) |
| 2 | Memory | Bot said "no saved memories" despite having them | Medium | Fixed (recall_memory recency fallback) |
| 3 | Files | Bot said "no permission" for find_files — governance blocking find | Medium | Fixed (find_files tool added) |
|   |      |       |          |        |

---

## Phase B: Ship v0.2

After dogfooding, prepare for others to install.

### B1. Packaging
- [ ] `npm install -g multis` works on a fresh machine
- [ ] `multis init` → `multis start` path works without cloning repo
- [ ] `.env.example` has all required variables documented
- [ ] `multis --version` prints version

### B2. Onboarding Docs
- [ ] Getting started guide (5-minute path to first `/ask`)
- [ ] Configuration reference (all config.json fields)
- [ ] Beeper setup guide (standalone, not just the script)
- [ ] Troubleshooting / FAQ

### B3. Stability
- [ ] CI: GitHub Actions running `npm test` on push
- [ ] Error recovery: LLM timeout, SQLite locked, network flap
- [ ] Graceful shutdown (SIGTERM handler in daemon) — already wired

---

## Phase C: Feature Gaps (as needed)

Only tackle these if dogfooding reveals they matter.

- [ ] Cron/reminders (`/remind <time> <message>`, `/cron <schedule> <action>`)
- [ ] Tier 2 PDF parsing (font-size heading detection)
- [ ] File upload indexing on Beeper (not just Telegram)
- [ ] ACT-R activation visible in `/search` results
- [ ] `/index` for URLs (fetch + parse web pages)

---

## Phase D: POC 7 — Multi-Platform (deferred)

Self-hosted Matrix + mautrix bridges. Only when there's a real need beyond Telegram + Beeper Desktop.

See: `docs/02-features/multi-platform.md`
