# Roadmap: Post-POC

> POC 1-6 complete. Next: dogfood, stabilize, ship.

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
- [ ] `/mode personal` — requires PIN? Sets mode?
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

### A3. Beeper End-to-End

- [ ] `node src/cli/setup-beeper.js` — OAuth flow works?
- [ ] Beeper Desktop running with API enabled?
- [ ] `node bin/multis.js start` — Beeper connects, shows account count?
- [ ] Send `//status` from a self-chat — responds?
- [ ] Send `//help` — shows commands?
- [ ] Type a question in self-chat (no `//`) — implicit ask works?
- [ ] `//exec ls ~` — PIN → output?
- [ ] `//search <term>` — finds docs?

#### Mode tests (Beeper)

- [ ] `//mode business` from self-chat → interactive picker? Pick a chat → set?
- [ ] `//mode silent John` from self-chat → search by name → set?
- [ ] `//mode business` in a non-self chat → sets current chat directly?
- [ ] Send message from contact in business-mode chat → auto-responds?
- [ ] Send message from friend in silent-mode chat → archived but no response?
- [ ] `/mode personal` from self-chat → set a chat as personal for second admin?

### A4. Edge Cases & Error Handling

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

### A6. Multi-Agent

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

### A5. Bug & Friction Log

Keep a running list here as you test. Each entry: what happened, expected vs actual.

```
| # | Area | Issue | Severity | Status |
|---|------|-------|----------|--------|
|   |      |       |          |        |
```

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
- [ ] Graceful shutdown (SIGTERM handler in daemon)

---

## Phase C: Feature Gaps (as needed)

Only tackle these if dogfooding reveals they matter.

- [ ] Tier 2 PDF parsing (font-size heading detection)
- [ ] File upload indexing on Beeper (not just Telegram)
- [ ] Cleanup cron wired into daemon startup
- [ ] ACT-R activation visible in `/search` results
- [ ] `/index` for URLs (fetch + parse web pages)

---

## Phase D: POC 7 — Multi-Platform (deferred)

Self-hosted Matrix + mautrix bridges. Only when there's a real need beyond Telegram + Beeper Desktop.

See: `docs/02-features/multi-platform.md`
