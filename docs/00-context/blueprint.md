# multis Blueprint

The master reference for all decisions, flows, and architecture. If it's not here, it wasn't agreed.

---

## 1. What multis Is

A personal and business AI agent that lives in your chat apps. Runs locally on your machine, indexes your documents, remembers conversations per-chat via a use-based promotion ladder (episodes → durable facts), and auto-responds to contacts when you want it to.

**Core principles:**
- Local-first — all data on your machine
- LLM agnostic — Anthropic, OpenAI, Ollama, swap without code changes
- Governance-first — allowlist/denylist + audit logs on everything
- Vanilla Node.js — standard library first, minimal deps
- Per-chat isolation — every chat is its own world, no data leaks between them

---

## 2. Platforms

### Platform roles

| Platform | Role | Details |
|----------|------|---------|
| **Beeper Note-to-self** | Primary admin | Owner commands, `/mode`, `/ask`, monitoring. Always available when Beeper Desktop is running. |
| **Telegram bot** | Personal-bot transport | Owner-only, bound 1:1 to the personal-bot role (§3g). No contact chats; never controls Beeper. |
| **Beeper chats** | Gateway to all contacts | WhatsApp, Telegram, LinkedIn, etc. come through Beeper bridges. Per-chat modes (business/silent/off). Business-mode contacts get auto-responses without pairing. |
| **Self-hosted Matrix** | Future alternative to Beeper | VPS + domain, $5-10/month. Planned (POC7). |

**Command channel (bound to role, §3g)**: the owner's command channel is bound 1:1 to the account role, not offered as an orthogonal pair. For a **personal-assistant / business** account it is **Beeper Note-to-self** — the only channel that sees the owner's real contacts, so it owns `/mode`, `/ask`, and all contact-mode control. For a **personal-bot** account it is **Telegram** (owner-only, no contacts). Telegram never controls Beeper chats — contact-mode control lives solely in Beeper Note-to-self; role changes go through `multis init`. Telegram bot is not customer-facing — other Telegram contacts reach multis through Beeper's Telegram bridge, alongside WhatsApp, LinkedIn, etc.

### Platform abstraction

```
Platform (base.js)
  ├── start(), stop(), send(chatId, text), sendFile(chatId, filePath, caption), onMessage(callback)
  │
  ├── TelegramPlatform  — Telegraf wrapper, admin-only, / prefix
  ├── BeeperPlatform    — polls localhost:23373, / prefix, all bridges (WhatsApp, Telegram, LinkedIn, etc.)
  └── MatrixPlatform    — (future) Matrix SDK client
```

All platforms emit normalized `Message` objects → single router handles everything.

**Platform registry**: `createMessageRouter()` returns a handler with `registerPlatform(name, instance)`. Each platform registers itself at startup (`handler.registerPlatform('beeper', beeper)`). The registry backs owner-ceremony routing (a PIN prompt reaches the owner on the right channel) and business escalation (routing a customer escalation to the owner's admin channel). It is NOT a cross-platform admin bridge — Telegram's `/mode` does not reach Beeper (§3g).

### Message routing flow

```
Message arrives
  │
  ├─ Starts with [multis] → SKIP (our own response)
  │
  ├─ msg.routeAs === 'off'? → SKIP (defense-in-depth, no logging)
  │
  ├─ msg.routeAs === 'silent'? (chat in silent mode)
  │   └─ YES → log + record an episode (feeds the promotion ladder), NO response
  │
  ├─ Is a command? (/ on all platforms, personal chats only on Beeper)
  │   └─ YES → parse command → switch (ask, mode, exec, read, index, search, ...)
  │
  ├─ msg.routeAs === 'natural'? (self-message in personal chat)
  │   └─ YES → routeAsk(msg.text) — implicit question
  │
  ├─ msg.routeAs === 'business'? (incoming message in business-mode chat)
  │   ├─ Owner message? → set admin pause, archive, RETURN (bot pauses)
  │   ├─ Admin paused? → archive silently, RETURN (bot still paused)
  │   └─ YES → routeAsk(msg.text) — auto-respond (LLM has escalate tool)
  │
  └─ else → IGNORE
```

### Beeper-specific

- **Startup health check**: on server start, check if Beeper Desktop is running (hit `localhost:23373`). If not reachable, log warning and disable Beeper platform gracefully — don't crash. Re-check periodically or on-demand. (TODO: implement in polish pass or POC6 daemon)
- **Self-chat detection**: at startup, identify chats with type=single + ≤1 participant
- **Mode lookup**: `config.chats[chatId].mode` → fallback to `default_mode`
- **Self messages in personal chats**: routed as natural language (routeAs: 'natural')
- **Incoming messages in business chats**: auto-responded (routeAs: 'business')
- **File indexing via chat**: admin sends a file (PDF/DOCX/MD/TXT) with `/index <scope>` in Note-to-self → bot downloads via `POST /v1/assets/download`, indexes locally. If no scope specified, bot asks "Reply 1 (public) or 2 (admin)". Uses `_attachments` on the normalized Message (same pattern as Telegram's `_document`)
- **Hibernate/sleep re-seed**: if poll gap exceeds 30s (expected ~3s), re-seeds `_seen` set from current messages to avoid reprocessing stale messages after wake

---

## 3. Profiles and Chat Modes

### Profiles (set at init)

A **profile** is a global setting chosen during `multis init`. It determines the default mode for all chats.

| Profile (`bot_mode`) | Set at | Default mode for chats | Use case |
|---------|--------|----------------------|----------|
| **personal-assistant** | `multis init` | personal | Private assistant on Beeper — capture conversations; respond only when the assistant is named (M8) |
| **personal-bot** | `multis init` | off (contacts ignored) | Telegram, owner-only — no contact chats |
| **business** | `multis init` | business | Customer support — bot auto-responds to all incoming messages |

Profile is stored as `bot_mode` in config.json. It does not change per-chat — it only sets the default.

### Modes (per-chat)

The engagement ladder (M8), per-chat, switchable anytime via `/mode`. The profile determines the default; a per-chat `/mode` can only step a chat DOWN to silent/off or back to the account default (it can't cross to another account's engaged rung).

| Mode | Self messages | Incoming messages | Admin commands | Use case |
|------|--------------|-------------------|----------------|----------|
| **business** | Commands + natural ask | Auto-respond via LLM | No | Customer support, business contacts. Use `/agent` to assign different agents per chat |
| **personal** | Commands + natural ask | Respond only when the assistant is **named**; else captured | No | Private assistant — jumps in when summoned by name (`/name`) |
| **silent** | Ignored | Archived to memory | No | Passive capture — track conversations without bot output |
| **off** | Ignored | Ignored | No | Completely ignored — no archive, no response |

### Canonical Mode Semantics

| Mode | Who's in it | Logs | Memory/DB | Bot responds | Slash commands |
|------|-------------|------|-----------|--------------|----------------|
| business | Customer chats | Yes | Yes | Yes | No (contact can't) |
| personal | Contact chats | Yes | Yes | Only when named | No (contact can't) |
| silent | Customer chats | Yes | Yes | No | No (contact can't) |
| off | Customer chats | No | No | No | No (contact can't) |
| Note-to-self | Admin (you) | Yes | Yes | Yes | Yes |

Personal/note-to-self chats cannot be set to `silent` or `off`.

Self-chats (note-to-self, WhatsApp self) are auto-detected as **off** (command channel, not a contact).

### Setting modes

- **Owner required** to change any chat's mode
- `/mode` (no args) → lists recent chats with current modes (top 20, no PIN)
- `/mode <mode>` in a chat → sets that chat directly
- `/mode <mode>` in self-chat → interactive picker (top 20 recent chats)
- `/mode <mode> <name>` in self-chat → search by name across all chats (top 100). 1 match → sets immediately, multiple → numbered picker

**From Telegram** (personal-bot transport — never controls Beeper, §3g):
- `/mode` (any form) → reports the account role and points role changes at `multis init`. Telegram has no contact chats to manage; contact-mode control lives solely in Beeper Note-to-self. Changing the account type (and thus the engaged style for all chats) is a re-init, which reconciles per-chat modes on the switch.

### Chat tracking

Only the **20 most recent chats** are polled each cycle. This is a sliding window — when a dormant chat receives a new message, it enters the top 20 and gets picked up on the next poll. Over time, all active chats are tracked. Dormant chats with zero activity are not monitored (no wasted storage).

**Storage chain for silent mode**: message arrives → polled (if in top 20) → archived to `memory/chats/<chatId>/` (rolling window + daily log) → rolling window overflows → LLM summarizes → summary indexed to SQLite FTS DB as scoped chunk.

**Business mode**: same archival path, plus the bot auto-responds via LLM.

**Off mode**: completely skipped — no archive, no response, no storage.

### Beeper API limitation

The Beeper Desktop API (`/v1/chats`) only returns chats that Beeper has loaded in memory. Inactive/archived chats (e.g. old LinkedIn conversations) are not returned even with high limits. This means:

- **`/mode <mode>`** (picker): shows top 20 recent — always works for active chats
- **`/mode <mode> <name>`** (search): searches top 100 — finds most chats but not deeply archived ones
- **Dormant chats**: cannot be pre-configured via `/mode`. When the contact messages you, the chat becomes active, enters the API response, and gets tracked per your profile default (silent or business). You can then change its mode

This is acceptable — there's no reason to set a mode on a chat with zero activity. The profile default handles new/reactivated chats automatically.

### Typical workflows

**Personal profile**: all chats default to `silent`. Override specific chats to `off` if you don't want tracking, or to `business` if you want the bot to respond (e.g. a group you manage).

**Business profile**: all chats default to `business`. Override specific chats to `silent` (monitor without responding) or `off` (ignore completely). Use `/agent` to assign different agents per chat (e.g. `support` for customers, `sales` for suppliers).

### Privilege model

| Context | Admin commands? | Scope | Bot responds? |
|---------|----------------|-------|---------------|
| Owner in any chat | Yes | All | To commands |
| Off-mode chat | No | n/a | Never |
| Business-mode chat | No | kb + user:chatId | Auto to all incoming |
| Silent-mode chat | No | n/a | Never |

### Default behavior by profile

| Profile (`bot_mode`) | New Beeper chats default to | Telegram |
|----------------------|----------------------------|----------|
| **personal** | silent (archive only) | off (owner sets mode manually) |
| **business** | business (auto-respond) | off (owner sets mode manually) |

**Persisted to:** `config.chats[chatId].mode`
**Fallback chain:** per-chat mode → beeper `default_mode` → profile (`bot_mode`) default → 'off'

---

## 4. Document Indexing + RAG

### Indexing pipeline

```
File → Parser (PDF/DOCX/MD/TXT) → Sections → Chunker → SQLite FTS5

Sources:
  ├─ /index <path> <scope>     — local file path (all platforms)
  ├─ Telegram file upload       — bot downloads via getFileLink(), indexes as kb
  └─ Beeper file attachment     — bot downloads via POST /v1/assets/download, scope from text or interactive prompt
```

- **Chunk size:** 2000 chars, 200 overlap, sentence-boundary-aware
- **Section path:** heading hierarchy preserved as JSON array
- **Activation columns:** `base_activation`, `last_accessed`, `access_count` (for ACT-R)

### RAG pipeline

```
Question → FTS5 search (top 5) → buildRAGPrompt(question, chunks) → LLM → answer with citations
```

- System prompt: "You are multis... cite sources as [filename, page X]..."
- Each chunk formatted with metadata: filename, section path, page range
- If no chunks found: "No matching documents found"
- If no LLM configured: "LLM not configured" error

### LLM providers

Providers are handled by `bare-agent` library. Configuration in `~/.multis/config.json`:

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "apiKey": "sk-..."
  }
}
```

| Provider | Config key | Notes |
|----------|-----------|-------|
| Anthropic | `apiKey` required | Default provider |
| OpenAI | `apiKey` required | Supports custom `baseUrl` for compatible APIs |
| Ollama | No key needed | Local, set `baseUrl` if non-default |

**OpenAI-compatible APIs:** Set `provider: "openai"` with custom `baseUrl` (OpenRouter, Together, Groq, vLLM, etc.).

**Adapter:** `src/llm/provider-adapter.js` maps config to bare-agent provider instances.

### bare-agent + bareguard integration

The agent loop is provided by `bare-agent ^0.10.1`. All governance (allowlists, audit, budget, humanChannel) is delegated to `bareguard ^0.4.1` via `wireGate(gate, { actionTranslator })`.

| Component | Package | What it does |
|-----------|---------|--------------|
| **Loop** | bare-agent | LLM → tool_use → execute → loop. `policy(tool, args, ctx)` from wireGate gates every tool call. `onLlmResult`/`onToolResult` callbacks forward usage to `gate.record` so `budget.maxCostUsd` covers BOTH LLM and tool spend. `HaltError` from the policy exits the loop cleanly (never leaks `[HALT:]` to the model). Drives `/ask` and `/plan` |
| **Gate** | bareguard | Single source of truth for governance: `bash.allow`/`bash.denyPatterns`, `fs.readScope`/`fs.deny`, `content.askPatterns` (absorbs multis' prompt-injection patterns), `secrets.envVars`, `budget.maxCostUsd`, `limits.maxToolRounds`, `humanChannel` (single callback for every ask/halt). Built lazily in `src/governance/gate.js` (bareguard is ESM, multis is CJS — dynamic import) |
| **wireGate** | bare-agent/bareguard | `wireGate(gate, { actionTranslator })` returns `{policy, onLlmResult, onToolResult, filterTools}`. multis' translator only maps tool NAMES (`exec → bash`, `read_file/send_file/grep_files/find_files → read`) — args pass through verbatim because bareguard 0.4.1+ reads `args.command` / `args.path` via fallback. Owner-bypass for non-owner shell tools is layered as a pre-check before `wireGate.policy` and recorded to the gate audit |
| **humanChannel** | bareguard contract | `src/governance/human-channel.js` routes ask/halt back to the originating chat via `event.action._ctx.{platform, chatId, senderId}` (v0.4 contract); reuses the pending-reply Map pattern from `src/bot/checkpoint.js` |
| **Retry** | bare-agent | Automatic retry on 429/5xx with configurable max attempts and timeout |
| **CircuitBreaker** | bare-agent | Shared per-process, opens after N failures, resets after cooldown. Wraps the provider |
| **Checkpoint** | bare-agent | Retained for non-policy "always confirm" flows (e.g. `send_email`-style). humanChannel handles policy-driven approvals; Checkpoint handles the rest |
| **Planner** | bare-agent | Breaks a goal into steps. Used by `/plan` command |
| **Scheduler** | bare-agent | Time-triggered jobs, persists to `~/.multis/data/scheduler.json`, 60s poll interval |

Config for retry and circuit breaker in `config.json`:

```json
{
  "llm": {
    "max_tool_rounds": 5,
    "retry": { "maxAttempts": 3, "timeout": 30000 },
    "circuit_breaker": { "threshold": 5, "resetAfter": 30000 }
  }
}
```

---

## 5. Memory System

### Per-chat isolation

Every chat gets its own memory. No global state. No cross-chat contamination.

```
~/.multis/data/memory/chats/<chatId>/
└── log/
    └── YYYY-MM-DD.md # raw daily log (append-only, auto-cleaned at 30 days)

~/.multis/data/litectx.db  # durable memory + conversation thread (facts + episodes) — tenant-scoped, ONE store
```

Since M4, neither durable memory nor the conversation thread lives in per-chat files. Both live in the single litectx store (`litectx.db`), fenced per tenant by scope (`admin` / `user:<chatId>`) — the same fence that isolates uploaded documents. Every exchange is an `episode`; the agent's message window is reconstructed from litectx episode-recency (`recentMemory`, 0.23.0), so the old `recent.json` window file is **gone**. Per-chat files keep only the one thing litectx doesn't: the raw daily logs (verbatim forensic backup, never indexed).

Chat metadata (name, network, platform, mode, lastActive) is stored in `config.chats[chatId]` — a single source of truth in config.json, not per-chat files.

Admin identity aggregation — admin talks from multiple platforms (Telegram, Beeper Note to Self, WhatsApp self-chat). All admin chats share one `admin` memory scope in litectx (a customer's facts/episodes are fenced under `user:<chatId>`, never cross-visible):

```
~/.multis/data/memory/chats/
  ├── tg-12345/                # telegram chat (admin) — daily log only
  │   └── log/
  ├── beeper-xyz/              # beeper chat (admin) — daily log only
  │   └── log/
  └── beeper-customer-abc/     # customer chat — daily log only
      └── log/
# durable memory AND the conversation thread for all of the above live in litectx.db, scoped:
#   admin chats → scope 'admin' (shared)      customer chats → scope 'user:<chatId>' (isolated)
```

### What each file does

| File | Written by | Read by | Purpose |
|------|-----------|---------|---------|
| `config.chats[chatId]` | Router (`updateChatMeta`) | Router, `/mode`, `listBeeperChats` | Chat metadata (name, network, platform, mode, lastActive) |
| `litectx.db` | `rememberEpisode`/`rememberFact` + promotion sweep | `recallMemory` (relevance) + `recentMemory` (the conversation window) + `recall_memory` tool | Durable memory AND the conversation thread (facts + episodes), tenant-scoped |
| `log/*.md` | Router (every message) | Human (backup only) | Raw append-only backup, NOT indexed |

### Two memory tiers (the promotion ladder)

Durable memory is litectx's native episode→fact ladder — **no LLM summarization step**. Memory is earned by use, not extracted on a timer.

| Tier | Storage | What | Lifecycle |
|------|---------|------|-----------|
| **Conversation window** (litectx episode-recency) | `litectx.db` | Last ~20 turns, reconstructed from recent episodes' `meta.turns` | The cross-message thread the agent loop replays. `recentMemory`, newest-first; no separate file |
| **Episodes** (litectx `episode`) | `litectx.db` | Every exchange, recorded verbatim (`by:'agent'`), tenant-scoped | Expire at TTL (90d customer / 365d admin). The "scratchpad" rung |
| **Facts** (litectx `fact`) | `litectx.db` | The durable subset — `/remember` (`by:'human'`, instant) or promoted episodes (`by:'agent'`, verbatim) | Don't expire. Recalled facts-first |

**Key insight:** every exchange is a cheap, expiring episode; the thin layer you keep coming back to is promoted to a permanent fact — copied **verbatim, no summarizer**. The flood of one-off chatter simply expires. Promotion is driven by *recall* (use), so the same retrieval that builds the prompt is the signal that earns permanence.

### Exchange → episode → promotion cycle

```
Message / exchange → append to daily log + write the episode (the conversation thread)
                     │
                     ▼
              rememberEpisode(scope, turns)  # by:'agent', meta.turns = role-tagged turns (window replay),
                     │                        # monotonic occurredAt, expiresAt = role TTL (90d / 365d)
                     │    scope = 'admin' (admin chat) | 'user:<chatId>' (customer)
                     ▼
              promotionSweep(scope)  (fire-and-forget, after a response):
                     │
                     ├─ promotionCandidates(threshold=10)  # episodes recalled ≥10× within
                     │                                      # the episode window (episode_window_days, default 90)
                     │
                     └─ for each hot candidate: copy episode text VERBATIM → fact (by:'agent')
                            (re-sweep UPSERTS the same fact id — no duplicates)

/remember <note>  →  rememberFact(scope, note, by:'human')   # durable immediately, top trust
recall (prompt build + recall_memory tool)  →  recallMemory(query, {scope})  # facts-first ∪ episodes, scope ∪ GLOBAL
/memory           →  recentMemory(scope, {kind:['fact','episode']}) + count   # list durable facts + recent episodes
window (agent msg history)  →  recentMemory(scope, {kind:'episode'})  # newest-first → reverse → meta.turns
/forget           →  forgetMemory(scope)   # tenant-only (clears facts+episodes = the thread); never another chat or the KB
```

**Episodes = hot scratchpad, facts = what earned its place.** When the LLM needs durable context, `recall_memory` (and the prompt builder) call `recallMemory`, which fences to `scope ∪ GLOBAL` over the fact/episode kinds; the conversation window comes from `recentMemory(kind:'episode')`. Recall blends BM25 + semantic (KNN) so a reworded question still matches (`memory.semantic`, on by default). Daily logs stay raw backup only, never indexed.

### Retention and cleanup

| What | Default | Config key | Cleanup |
|------|---------|------------|---------|
| Episodes | ~90 days (configurable) | `memory.episode_window_days` (default 90) | litectx self-prunes on the rolling window (litectx 0.25.0 `episodeWindowDays`); the **same** window also gates promotion-eligibility (one coupled clock). Durability is promotion-to-fact, not the timer |
| Facts | Permanent | — | Promoted/`/remember`'d facts don't expire (drop them with `/forget`) |
| Daily logs | 30 days | `memory.log_retention_days` | Delete old `log/YYYY-MM-DD.md` files |

### Promotion (no capture skill, no LLM)

Since M4 there is **no LLM capture/summarize step** and no human-written `capture.md`. Durable memory is earned by use: every exchange is an `episode`; `promotionSweep` copies an episode **verbatim** to a `fact` once it's been recalled ≥`promote_threshold` (10) times within the episode window (`memory.episode_window_days`, default 90 — litectx 0.25.0; the window is BOTH retention and promotion-eligibility, one coupled clock) — an episode that never gets that hot simply prunes at the window edge (durability lives in the fact tier, not in the episode timer). `/remember` writes a `fact` directly, and a restated same-subject note **supersedes** the prior fact in place rather than piling up a contradiction (an LLM judge picks the fact to overwrite; tenant-fenced, fail-toward-keep — see Memory supersession below). litectx owns ranking (BM25 + optional KNN when `memory.semantic` is on, the default), decay, and retention — multis only writes episodes/facts and reads them back.

### Memory supersession (W4 — restated facts update in place)

litectx 0.24.0 makes `remember(id, …)` a **tenant-fenced upsert by `(scope, id)`**: re-asserting the same id under the same scope replaces the value in place; the same id under another scope is a separate row. litectx delivers the keyed write; deciding *"this new fact restates-and-updates an existing one"* is multis's job (`src/memory/supersede.js`). On every `/remember` (both the slash app-verb and the LLM `remember` tool flow through `rememberWithSupersede`):

1. Recall the most-relevant existing facts for this tenant (`factCandidates`, scope-fenced, `log:false` so the check doesn't inflate the use signal).
2. An LLM judge (`memory.supersede`, default on; `memory.supersede_candidates`, default 5) classifies the note as **`UPDATE <n>`** — same subject as candidate *n*, value revised, so the old is obsolete (explicit changes like "moved"/"now" **and** a new value for a singular attribute the user has one of: weight, wedding date, address, deadline) — or **`NEW`** (distinct subject, or genuinely can't tell → keep both).
3. Write under the chosen id (overwrite) or a fresh id (new fact).

**Auto-update + tell-me (owner decision 2026-06-28):** an `UPDATE` overwrites silently-but-visibly — the reply names the prior value (`Noted — updated your earlier note (was: "…")`; the agent tool returns the same so the model relays it), so a wrong auto-update is **seen and recoverable** (re-`/remember` the old value) rather than a hidden destroy. No confirm dialog — the transparency is what makes aggressive update-detection safe, which is why the judge is tuned to *catch* singular changes rather than ask. Customer-scope facts (agent-created) auto-update silently; the tell-me surfaces on the owner's own chats.

Two invariants bound the risk: **fail toward keeping** — any uncertainty (`NEW`), a hallucinated/out-of-range choice, an LLM error, a recall failure, no provider, or `supersede:false` all degrade to a plain new-fact write (a false-merge that overwrites a still-true fact is the worst outcome, so ambiguity never destroys); and **scope-fenced blast radius** — candidates come from a scope-bound recall, so even a wrong merge can only touch this tenant's own memory, never another's. The judge is characterized by real-LLM POCs (binary UPDATE/NEW 12/12, incl. the live-observed misses now caught — moved wedding, changed deadline — and zero false-merge across distinct subjects); its safety wrapper is unit-tested deterministically.

### Memory in LLM calls

```
System prompt:
  ├─ Base: "You are multis, a personal/business assistant..."
  ├─ Recalled memory: recallMemory(query, {scope}) → facts-first ∪ episodes for THIS tenant
  │   (admin chats → scope 'admin'; customer chats → scope 'user:<chatId>')
  └─ RAG chunks: scoped document search results (if applicable)

Messages:
  ├─ conversation window: recentMemory(scope, {kind:'episode'}) → reverse → meta.turns (last N turns)
  └─ Current message
```

### Memory commands

| Command | What it does |
|---------|-------------|
| `/memory` | List this tenant's durable facts + recent episodes (newest-first, via `recentMemory`) with a per-kind `count` |
| `/forget <topic>` | Remove matching notes (pick if several); cascades a promoted fact to its source episode; `/forget all` clears the tenant (facts + episodes = the thread too). Tenant-fenced; raw logs kept |
| `/remember <note>` | Write a durable `fact` (`by:'human'`, top trust, instant) |

### recall_memory tool

The LLM has a `recall_memory` tool that recalls this tenant's `fact`/`episode` memory (never documents). Used when the user references something discussed before ("do you remember...", "my wife's name", "what did I say about..."). It fences to `scope ∪ GLOBAL`, facts ranked before episodes.

- **Role-filtered**: owner sees all roles; non-owner only sees `role='user:<chatId>'` memories
- **Type-filtered**: `store.search()` accepts a `types` option that adds `AND c.type IN (...)` to the SQL query
- **Recency fallback**: when FTS query is all stopwords (e.g. "what did we talk about last"), `store.recentByType()` returns the most recent `type='conv'` chunks by `created_at DESC` — same role/type filtering, no FTS match required
- **Not owner_only**: customers can recall their own scoped memories too

---

## 6. Data Isolation + Chunk Scoping

### Schema: type / element / role

Every chunk has three orthogonal fields:

| Field | Values | Purpose |
|-------|--------|---------|
| `type` | `kb`, `conv` | Chunk category — documents vs conversation summaries |
| `element` | `pdf`, `docx`, `md`, `txt`, `chat` | Source format |
| `role` | `public`, `admin`, `user:<chatId>` | Access control |

### Role model

Every chunk in the FTS index has a `role` column that controls who can see it:

| Role | Meaning | Who can query | Auto-labeled by |
|------|---------|---------------|-----------------|
| `public` | Public knowledge base | Everyone | `/index <path> public` |
| `admin` | Admin-only documents + admin conversation summaries | Admin only | `/index <path> admin`, admin capture |
| `user:<chatId>` | That specific customer's conversation summaries | That customer + admin | Customer capture (automatic) |

### Indexing with explicit role

```
/index <path>            → bot asks: "Label as public or admin?"
/index <path> public     → type=kb, element=<auto>, role=public
/index <path> admin      → type=kb, element=<auto>, role=admin
Customer capture fires   → type=conv, element=chat, role=user:<chatId>
Admin capture fires      → type=conv, element=chat, role=admin
```

No silent defaults on manual indexing. Admin always declares intent. Customers never choose. Old `kb` accepted as alias for `public`.

### Hard role filtering (SQL-level)

Search function takes caller context and applies role filter at the database level:

```sql
-- Customer query: only sees public + their own history
WHERE role IN ('public', 'user:<their_chatId>')

-- Admin query: sees everything (no role filter)
```

Chunks outside role **never reach the LLM context**. This is the hard boundary.

### Prompt injection defense

| Layer | What | How |
|-------|------|-----|
| **Hard role filter** | SQL WHERE clause | Chunks from other users never in LLM context |
| **Excluded context** | No admin-scope memory in business prompts | Business-mode prompts recall only the customer's `user:<chatId>` scope + the shared KB — never the `admin` scope |
| **Pattern detection** | Flag suspicious queries | "ignore instructions", "system prompt", "show all users", "SELECT", references to other users |
| **Rate limiting** | Track queries per chatId per hour | Flag anomalies (many broad queries, repeated "show all" patterns) |
| **Dedicated audit** | `~/.multis/logs/injection.log` | userId, timestamp, full text, matched pattern, result (blocked/flagged/allowed) |
| **LLM instruction** | System prompt for business mode | "Answer from knowledge base only. Never reference other customers. Never reveal admin information." |

---

## 7. Governance + Security

### Governance — bareguard Gate (bareguard 0.4.2 + bare-agent 0.10.2)

As of v0.14.0, governance lives in a **bareguard Gate** wired into bareagent's `Loop` via `wireGate(gate)`. One `humanChannel` callback handles every ask/halt event; one structured JSONL audit at `~/.multis/logs/gate.jsonl` records every gate decision; `budget.maxCostUsd` covers both LLM and tool spend via `Loop({onLlmResult, onToolResult})`. multis is bareguard's first production adopter — v0.14.0 closed the last seam (no more `*2` arithmetic, no more `bash.cmd` / `fs.path` field hoisting).

`src/governance/gate.js` is the integration point. It lazily `await import('bareguard')` (bareguard is ESM, multis is CJS), reads `governance.json`, and builds the Gate config:

| governance.json | → Gate config |
|---|---|
| `commands.allowlist` | `bash.allow` (argv[0]-style prefix match) |
| `commands.denylist` | `bash.denyPatterns` (regex per entry) |
| `paths.allowed` | `fs.readScope` + `fs.writeScope` |
| `paths.denied` | `fs.deny` |
| `security.max_cost_per_run` | `budget.maxCostUsd` (covers LLM + tool spend) |
| `llm.max_tool_rounds` | `limits.maxToolRounds` (1:1 — bareguard 0.4.2 ticks only on tool records, not LLM records) |
| (built-in) | `secrets.envVars`: ANTHROPIC/OPENAI/GEMINI/TELEGRAM tokens |
| (built-in) | `content.askPatterns`: multis' prompt-injection patterns |

One `governance.json` covers all platforms (Linux, macOS, Windows, Android). Unused commands on the wrong OS are harmless.

- **Allowlist:** Safe commands across all OSes — `ls`/`dir`, `cat`/`type`, `grep`/`find`/`where`, `curl`/`wget`, `git`/`npm`/`node`/`python`, media (`playerctl`, `osascript`), clipboard (`xclip`, `pbcopy`, `clip`), screenshots (`grim`, `screencapture`, `snippingtool`), Termux (`termux-*` for Android)
- **Denylist:** Destructive commands — `rm`/`rmdir`/`del`/`rd`, `sudo`/`su`/`runas`, `dd`/`mkfs`/`format`/`diskpart`, `chmod`/`chown`/`icacls`, `kill`/`killall`/`taskkill`, `shutdown`/`reboot`/`halt`
- **Path restrictions:** Allowed dirs (`~/Documents`, `~/Downloads`, `~/Projects`, `~/PycharmProjects`, `~/Desktop`) vs denied (`/etc`, `/var`, `/usr`, `/System`, `/bin`, `/sbin`, `C:\Windows`, `C:\Program Files`). Symlinks resolved via `realpathSync` before checking.
- **Cost cap:** Optional `config.security.max_cost_per_run` → `budget.maxCostUsd`. On halt, bareguard fires `humanChannel(event)` with the originating chat's `_ctx` so the prompt routes back to the right user. multis' default humanPrompt treats "yes" on halt as `terminate` (no top-up UX).
- **Action shape translation:** multis tool names (`exec`, `read_file`, `send_file`, `grep_files`, `find_files`) are mapped to bareguard's canonical types (`bash`, `read`) via `wireGate(gate, { actionTranslator })` (bareagent 0.10.2 / bareguard 0.4.2 seam). bareguard's `bashCheck` reads `args.command` and `fsCheck` reads `args.path` via fallback, so the translator passes args through verbatim — no field hoisting. Symlinks are resolved via `realpathSync` and written back to `args.path` inside the translator before the gate sees them. `send_file` is mapped to `{type:'read'}` so `fs.deny` gates outbound files.
- **Halt protocol:** halt-severity decisions throw `HaltError` from the policy; Loop catches it, exits cleanly, and returns `result.error = 'halt:<rule>'`. The `[HALT:]` string never reaches the LLM. (multis surfaces this to the user as a normal "LLM error" via the existing try/catch.)
- **Audit split:** bareguard writes gate decisions to `~/.multis/logs/gate.jsonl` (forensic, structured by phase: `gate`, `record`, `approval`, `halt`, `topup`, `terminate`). multis' `src/governance/audit.js` keeps the 50+ app-event call sites at `~/.multis/logs/audit.log` (pairing, mode change, capture, escalation, etc.).

### PIN authentication (POC6)

Owner commands require periodic PIN verification to guard against borrowed-device attacks:

```
Owner command arrives
  → check last_auth_at for this userId
  → if > auth_timeout (default 24h): ask for PIN, queue the command
  → if PIN correct: set last_auth_at = now, execute command
  → if wrong 3x: lock for 1h, alert via all platforms
```

- PIN set during `multis init` (4-6 digits)
- Stored hashed in `config.json` (`pin_hash`)
- `last_auth_at` per userId stored in memory
- Timeout configurable: `config.security.pin_timeout_hours` (default 24)
- Lockout configurable: `config.security.pin_lockout_minutes` (default 60)
- Failed attempts logged to `logs/audit.log`

### Audit logging
- Append-only JSONL at `~/.multis/logs/audit.log`
- Every command logged: timestamp, user_id, command, allowed, result
- Actions logged: pair, unpair, exec, index, search, ask, mode change, pin_auth, pin_fail
- Prompt injection attempts: `~/.multis/logs/injection.log` (separate file)

### Owner model
- First paired user becomes owner (set during init via inline Telegram pairing)
- Owner-only (requires PIN): `/exec`, `/read`, `/index`, `/mode`
- Everyone else: `/ask`, `/search`, `/docs`, `/status`, `/help`
- Off-mode chats are completely ignored (no archive, no response)
- All user IDs stored and compared as strings (Telegraf sends numbers, config stores strings)

### Future: ABAC policy matrix (replaces flat allowlist)

The current flat allowlist/denylist works for 2 roles (owner vs not-owner). When more roles or context-dependent rules are needed, upgrade to Attribute-Based Access Control — a policy matrix evaluated across multiple dimensions:

```
role × action × resource × context → allow | deny | confirm
```

#### Policy table format

```json
{
  "policies": [
    { "role": "owner",    "action": "exec",   "path": "~/Projects/*", "decision": "allow" },
    { "role": "owner",    "action": "exec",   "path": "/etc/*",       "decision": "deny" },
    { "role": "owner",    "action": "rm",     "path": "*",            "decision": "confirm" },
    { "role": "operator", "action": "read",   "path": "~/Documents/*","decision": "allow" },
    { "role": "operator", "action": "exec",   "path": "*",            "decision": "deny" },
    { "role": "customer", "action": "ask",    "path": "*",            "decision": "allow" },
    { "role": "customer", "action": "exec",   "path": "*",            "decision": "deny" },
    { "role": "*",        "action": "*",      "path": "*",            "decision": "deny" }
  ]
}
```

First match wins. Last rule is default-deny. Wildcards for catch-all.

#### When to upgrade from flat allowlist

- Multiple admin tiers (owner vs operator vs viewer)
- Per-customer permission overrides
- Context-dependent rules (time of day, platform, chat mode)
- External service tools (Section 15) with per-service permissions

#### Layered injection detection (same principle)

Independent detection layers, each scoring independently, combined into a final decision:

| Layer | Detects | Method |
|-------|---------|--------|
| Pattern match | "ignore instructions", "system prompt", "SELECT" | Regex |
| Scope violation | Query references other users or admin data | SQL + string check |
| Anomaly | Unusual query volume/breadth per chatId | Rate counter |
| Semantic | Adversarial intent in natural language | LLM judge call |

Combined score → allow / flag / block. Each layer is independent — one failing doesn't bypass the others.

#### Status: future (when flat lists stop being enough)

Current 2-role model with flat allowlist is correct for now. ABAC is the upgrade path when roles multiply or external service tools (Section 15) need per-service permissions.

---

## 8. Business Mode Escalation

### LLM-driven escalation

All business messages flow through the LLM — no keyword short-circuit. The LLM has an `escalate` tool and decides when to use it based on conversation context.

```
Customer asks a question
  │
  ├─ Admin paused? → archive silently, no response (admin handling it)
  │
  └─ LLM responds (always)
      │
      ├─ KB match → answer with citation
      ├─ No KB match → LLM responds naturally from persona
      ├─ Customer needs human attention → LLM calls escalate tool
      │   → Sends "[Escalation] <customer name>: <reason>" to admin_chat
      │   → LLM continues responding naturally and empathetically
      └─ Off-topic → LLM stays within configured topic boundaries
```

### Escalate tool

Defined in `src/tools/definitions.js`. Not owner_only — available in business conversations.

- `reason` (required): why this needs human attention
- `urgency` (optional): `normal` or `urgent`
- Sends to ALL admin channels automatically: Telegram (`config.owner_id`) + Beeper Note-to-self (via `getAdminChatIds()`)
- Optional override: `config.business.escalation.admin_chat` sends to a single specific chat instead
- Reads customer name from `config.chats[chatId].name`
- Returns "Admin notified. Continue responding naturally." to the LLM

### What triggers escalation (LLM-decided)
- Customer asks for a refund, files a complaint, or requests a manager
- Customer explicitly asks for a human ("can I talk to someone")
- Any request that involves action the bot cannot perform
- Configured `escalate_keywords` serve as guidance in the system prompt, not hard-coded triggers

### Admin presence pause

When the owner types directly in a business chat, the bot pauses for `admin_pause_minutes` (default 30, configurable in `config.business.escalation`). Customer messages during the pause are archived silently (appendMessage + appendToLog) but do not trigger LLM responses. The bot resumes automatically when the pause expires.

### Human in the loop — always
- Bot never promises action on behalf of admin
- Bot never creates reminders or commitments autonomously
- If customer requests follow-up: LLM calls escalate tool, admin gets notification
- Admin decides whether to act, remind, or ignore
- All messages are saved to memory (appendMessage + appendToLog) so conversation history stays complete

### Business persona (`/mode business`)

`/mode business` (no target) opens a 5-option menu: setup wizard, show, clear, set global default, assign chats. The wizard configures `config.business` fields: name, greeting, topics, rules, allowed_urls — with skip/clear support for re-running. The `buildBusinessPrompt()` function compiles these into a system prompt that replaces the default agent persona in business mode.

`allowed_urls` are reference links included in the prompt — the LLM cites them to customers when relevant. **Future: URL indexing** — fetch `allowed_urls` and index as KB chunks so the LLM has actual page content, not just links. Requires HTML-to-text conversion (`mozilla/readability` or similar). Could also work as a standalone `/index <url> <scope>` command beyond business mode.

---

## 9. Scheduler (DONE)

Built-in scheduler via bare-agent's `Scheduler`, runs inside the daemon process. **Admin-only.** Persists to `~/.multis/data/scheduler.json`, polls every 60s.

### Commands

| Command | What it does | Example |
|---------|-------------|---------|
| `/remind <duration> <action>` | One-shot reminder | `/remind 2h check inbox` |
| `/cron <expression> <action>` | Recurring scheduled task | `/cron 0 9 * * 1-5 morning briefing` |
| `/jobs` | List active scheduled jobs | |
| `/cancel <id>` | Cancel a scheduled job | `/cancel job-abc123` |

Duration format: `1m`, `5m`, `1h`, `2h`, `1d`, etc. Cron uses standard 5-field expressions.

### Core jobs (planned)

| Job | Frequency | What it does |
|-----|-----------|-------------|
| **Log cleanup** | Daily (on startup + 24h interval) | Delete daily logs older than `log_retention_days` |
| **Memory retention** | Daily | litectx `purge()` reclaims episodes past their `expiresAt` (90d / admin 365d); ranking/decay owned by litectx |

### Customer reminders
Customers cannot create cron jobs. If a customer requests a follow-up, the bot sends a note to admin. Admin decides whether to create a reminder.

---

## 10. Onboarding + Daemon (POC6)

### CLI — single entry point

Just type `multis` — interactive menu with numbered options and live status:

```
multis — personal AI assistant

Status: running (PID 12345)

  1) init      Set up multis (interactive wizard)
  2) start     Start daemon in background
  3) stop      Stop running daemon
  4) status    Check if daemon is running
  5) doctor    Run diagnostic checks
  0) exit      Quit this menu

Choose (0-5):
```

Direct commands also work: `multis start`, `multis stop`, `multis doctor`, etc.

Installed globally via `~/.local/bin/multis` symlink → works from any directory.

Chat is the primary interface. CLI is just for lifecycle management.

### `multis init`

Full onboarding wizard — init finishes = everything works.

**Re-init behavior:** When config already exists, each step shows the current value with `[Enter to keep]`. Pressing Enter skips that step entirely (no re-verification). Only steps where the user provides new input run the full setup flow. First-time users (no config) see the full wizard with no skip options.

```
multis init
  │
  ├─ Step 1: "What do you need?"
  │   ├─ Re-init: shows "Current: Personal assistant (Beeper)" + Enter to keep
  │   ├─ 1) Personal assistant (Telegram) → personal mode, Telegram only
  │   ├─ 2) Personal assistant (Beeper) [default] → personal mode, Beeper only
  │   └─ 3) Business chatbot (Beeper) → business mode, Beeper
  │       └─ Follow-up: "Also use Telegram as admin channel?" (y/n)
  │
  ├─ Step 2a: Telegram setup (if selected)
  │   ├─ Re-init: shows "@botname owner: ID ✓" + Enter to keep (skips verification)
  │   ├─ Paste token → format validation → getMe() verification
  │   ├─ Print "Token verified — bot is @username"
  │   ├─ Wait for /start (60s) → auto-pair as owner
  │   └─ Timeout: warn, continue (pair later)
  │
  ├─ Step 2b: Beeper setup (if selected) — via beeperbox MCP
  │   ├─ Re-init: shows "configured (mcp_url) ✓" + Enter to keep
  │   ├─ Prompt beeperbox MCP URL (:23375) + optional MCP token
  │   ├─ Verify via listAccounts verb (reuses setup-beeper.js exports)
  │   ├─ List connected accounts; detect bot chat via list_inbox
  │   └─ Show always-on warnings (beeperbox must be running)
  │
  ├─ Step 3: LLM provider
  │   ├─ Re-init: shows "Provider (model) ✓" + Enter to keep
  │   ├─ 1) Anthropic → ask key → verify with real API call
  │   ├─ 2) OpenAI → ask key → verify
  │   ├─ 3) OpenAI-compatible → ask base URL + model + key → verify
  │   └─ 4) Ollama → check localhost:11434 reachable
  │
  ├─ Step 4: PIN (4-6 digits, optional)
  │   └─ Re-init: shows "PIN: set ✓" + Enter to keep, or type new PIN
  │
  └─ Step 5: Save config + summary with verification status
```

Each platform and LLM provider is verified inline before moving on. No "next steps" the user can forget.

### Daemon startup

```
multis start
  │
  ├─ Write PID to ~/.multis/run/multis.pid
  ├─ Load config.json
  ├─ Start platforms (Telegram always, Beeper if reachable)
  ├─ Start cron scheduler (cleanup jobs)
  ├─ Run log cleanup + memory pruning (immediate)
  └─ Log "ready" + print pairing code
```

### Auto-start on boot
- Linux: systemd unit file (`scripts/multis.service`)
- macOS: launchd plist (future)
- No PM2 — native system services handle restarts and logging

---

## 11. Configuration

### Files

| File | Location | Purpose |
|------|----------|---------|
| `config.json` | `~/.multis/` | Main config — all behavioral settings with defaults |
| `tools.json` | `~/.multis/` | Tool enable/disable + platform restrictions |
| `.env` | Project root | API keys (overrides config.json) |
| `documents.db` | `~/.multis/data/` | SQLite: document chunks + FTS5 (type/element/role columns) |
| `memory/chats/` | `~/.multis/data/` | Per-chat profiles + memory |
| `governance.json` | `~/.multis/auth/` | Command allowlist/denylist |
| `pin_sessions.json` | `~/.multis/auth/` | PIN auth session state |
| `beeper-token.json` | `~/.multis/auth/` | Beeper Desktop API token |
| `audit.log` | `~/.multis/logs/` | Append-only audit log |
| `injection.log` | `~/.multis/logs/` | Prompt injection detection log |
| `daemon.log` | `~/.multis/logs/` | Daemon stdout/stderr |
| `multis.pid` | `~/.multis/run/` | Daemon PID file |

### Config structure

All behavioral settings are configurable. Sane defaults applied when missing.

```json
{
  "pairing_code": "F71A9B",
  "owner_id": "8503143603",
  "allowed_users": ["8503143603"],
  "bot_mode": "personal",
  "platforms": {
    "telegram": { "enabled": true, "bot_token": "..." },
    "beeper": {
      "enabled": true,
      "url": "http://localhost:23373",
      "poll_interval": 3000,
      "command_prefix": "/",
      "default_mode": "personal"
    }
  },
  "chats": {
    "!example_chat_id": {
      "name": "Customer Name",
      "network": "WhatsApp",
      "platform": "beeper",
      "mode": "business",
      "lastActive": "2026-02-23T18:46:29Z"
    }
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKey": "...",
    "baseUrl": ""
  },
  "memory": {
    "recent_window": 20,
    "promote_threshold": 10,
    "episode_window_days": 90,
    "log_retention_days": 30,
    "semantic": true,
    "supersede": true,
    "supersede_candidates": 5
  },
  "security": {
    "pin_hash": "...",
    "pin_timeout_hours": 24,
    "pin_lockout_minutes": 60,
    "prompt_injection_detection": true
  },
  "business": {
    "name": "Acme Support",
    "greeting": "Hi! How can I help you today?",
    "topics": [
      { "name": "Pricing", "description": "Plans and billing" },
      { "name": "Returns", "description": "Return policy", "escalate": true }
    ],
    "rules": ["Always respond in English"],
    "allowed_urls": [
      { "label": "Pricing", "url": "https://acme.com/pricing" },
      "https://acme.com/faq"
    ],
    "escalation": {
      "admin_chat": "tg-12345",
      "escalate_keywords": ["refund", "complaint", "urgent", "human", "manager"],
      "admin_pause_minutes": 30
    }
  },
  "governance": { "enabled": true }
}
```

---

## 12. Agent Tools

The LLM agent has access to tools via bare-agent's `Loop`. Tools are defined in `src/tools/definitions.js`, filtered by platform and owner status via `src/tools/registry.js`, adapted to bare-agent format via `src/tools/adapter.js`. Dangerous tools (default: `exec`) require human approval via bare-agent's `Checkpoint` — the bot asks "Allow [tool]? (yes/no)" and waits 60s for a reply before proceeding.

### Tool categories

| Category | Tools | Platforms |
|----------|-------|-----------|
| **Filesystem** | `read_file`, `grep_files`, `find_files`, `send_file` | all |
| **Shell** | `exec` | all |
| **Knowledge** | `search_docs`, `recall_memory`, `remember` | all |
| **Desktop** | `open_url`, `media_control`, `notify`, `clipboard`, `screenshot`, `brightness`, `wifi`, `system_info` | linux, macos |
| **Android** | `phone_call`, `sms_send`, `sms_list`, `contacts`, `location`, `camera`, `tts`, `torch`, `vibrate`, `volume`, `battery` | android |

### File tools

- **`read_file`** — read file or list directory, path-validated via governance
- **`grep_files`** — `grep -rn` wrapper, searches file contents by pattern in a directory
- **`find_files`** — `find -name` wrapper (maxdepth 5), locates files by name/glob
- **`send_file`** — sends a file as attachment to the chat. Telegram uses `sendDocument()`. Beeper not yet supported (graceful fallback). Path governance applies

### Governance integration

- `exec`, `grep_files`, `find_files` go through `isCommandAllowed()` allowlist
- `read_file`, `send_file` go through `isPathAllowed()` path restrictions
- All tool calls are audit-logged with tool name, input, user, status

---

## 13. Skills

### What skills are

Markdown files in `skills/` that define capabilities and policy. Skills are the governance unit for what the bot can do in a given context.

### Skill types

1. **Governance skills**: `shell.md`, `files.md` — what commands are allowed/denied
2. **LLM skills**: `capture.md` — instructions for LLM extraction
3. **Policy skills** (POC6+): `customer-support.md` — define role, allowed actions, memory rules per role

### Policy skill format

```yaml
---
name: customer-support
description: Handle customer queries from business-mode chats
roles: public + user:$chatId
escalation: true
allowed_urls: from config
actions: none
memory_rules:
  capture: true
  index: true
  visible: own
---

You are a support assistant for [business name].
Answer from the knowledge base only. Cite sources.
If unsure, say "Let me check with the team."
Never make promises. Never discuss other customers.
Never reveal internal processes or admin information.
```

### Default skills

| Skill | For | Scope | Actions |
|-------|-----|-------|---------|
| `admin.md` | Owner chats | `kb + admin + user:*` | exec, read, index, cron, all |
| `customer-support.md` | Business-mode chats | `kb + user:$chatId` | ask, search only |
| `capture.md` | Memory extraction | n/a | LLM instructions |

---

## 14. What We Borrowed and Changed

| Source | What | Our version |
|--------|------|-------------|
| **openclaw** | Daemon architecture | Same pattern, simpler (no gateway) |
| **openclaw** | Pairing flow | Same: code → send to bot → paired |
| **openclaw** | skill.md pattern | Same frontmatter format |
| **openclaw** | memory.md approach | Per-chat (not global), LLM-written |
| **openclaw** | Daily log files | Same: `YYYY-MM-DD.md` append-only |
| **openclaw** | Cron scheduler | Same pattern: jobs.json, periodic agent turns |
| **openclaw** | Pre-compaction flush | Our promotion ladder (litectx episode→fact) replaces it |
| **Aurora** | Document indexing | Ported: PDF/DOCX → chunking → FTS5 |
| **Aurora** | ACT-R activation decay | Inspiration only — ranking/decay now owned by litectx; conversations use the promotion ladder, not ACT-R |
| **Aurora** | Hierarchical chunking | Same: section path + sentence boundaries |
| **Aurora** | SQLite FTS5 | Same, but FTS5 BM25 replaces custom scorer |
| **mcp-gov** | Governance layer | Same: allowlist/denylist JSON + audit |

### Key difference from openclaw

One config, all chats. openclaw needs separate API integrations per channel. multis talks to Telegram + Beeper bridges + Matrix — all networks through one setup. Per-chat profiles keep everything isolated without multi-tenant complexity.

---

## 15. Future: External Service Tools

### Vision

The agent can interact with external services (Gmail, Spotify, Calendar, etc.) as tools — same pattern as existing agent tools but reaching outside the local machine.

### Architecture: single MCP, namespaced tools

One process, not one-per-service. Each service is a module that registers its tools:

```
~/.multis/mcp/services/
  gmail.js       → gmail:send, gmail:search, gmail:read
  spotify.js     → spotify:play, spotify:pause, spotify:search, spotify:queue
  calendar.js    → calendar:add, calendar:list, calendar:next
  browser.js     → browser:open, browser:click, browser:read_page
```

All loaded by a single MCP server process. Adding a service = drop a file, register tools. No new processes, no config changes beyond enabling the service.

### Three integration tiers

| Tier | Method | When to use | Example |
|------|--------|-------------|---------|
| **API-first** | OAuth token + REST calls | Service has a good API | Gmail, Spotify, Calendar, GitHub, Notion |
| **Browser fallback** | Playwright via `--remote-debugging-port=9222` | No API, or API is limited | Niche web apps, sites without public APIs |
| **Termux/shell** | `termux-api` commands via existing `/exec` | Android device control | SMS, contacts, camera, TTS, location |

### How it works

The LLM is the smart layer. Tools are dumb executors.

```
User: "text mom I'll be late"
  → LLM reasons: need contact lookup, then SMS
  → Tool call: contacts:search("mom") → returns number
  → Tool call: sms:send(number, "I'll be late")

User: "play some jazz"
  → Tool call: spotify:search("jazz playlist")
  → Tool call: spotify:play(playlist_uri)
```

### Auth model

- OAuth tokens stored in `~/.multis/auth/mcp/tokens/` (encrypted or via `pass`)
- Each service module handles its own token refresh
- First use triggers OAuth flow (browser opens, user consents, token saved)
- Owner-only — external service tools require PIN auth like `/exec`

### Browser automation (escape hatch)

For services without APIs, Playwright connects to the user's running Chrome:

- Chrome launched with `--remote-debugging-port=9222`
- Agent can open tabs, navigate, click, fill forms — using existing login sessions
- Generic tools: `browser:open`, `browser:click`, `browser:read_page`, `browser:fill`
- Fragile by nature — use only when API tier is not available

### Governance

- External service tools follow the same allowlist/denylist pattern as shell commands
- All calls audit-logged: service, action, input, user, timestamp
- Destructive actions (send email, delete, post) require confirmation or are denylist-only
- Read-only actions (search, list, read) are allowlist-safe

### Status: future (post-POC7)

Not needed yet. Current tools (filesystem, shell, knowledge, desktop, Android) cover personal use. External services are the next expansion when the core is stable.

---

## 16. Agent Evolution

The agent system evolves in tiers. Tier 1 and Tier 2 are done. Tier 3 is only if the product pivots from personal tool to platform.

Full design: **`docs/02-features/agent-evolution.md`** (architecture, schemas, size estimates, what to build vs skip)
First-principles breakdown: **`docs/02-features/agent-orchestration.md`** (orchestration components explained, actuation layers, why frameworks overcomplicate this)

### Tier 1: Agent Tool Loop (DONE)

LLM decides when to use tools in a multi-round loop. 25+ tools across filesystem, shell, desktop, Android. Multi-agent personas with @mention routing and per-chat assignment.

- `runAgentLoop()` in `handlers.js:586`
- `src/tools/definitions.js`, `registry.js`, `executor.js`
- `resolveAgent()` + `config.agents` for multi-persona

### Tier 2: Autonomous Agent (DONE)

Five components implemented via bare-agent wrappers in `src/bot/`:

| Component | Implementation | Status |
|-----------|---------------|--------|
| **Planner** | `bare-agent Planner` → `/plan <goal>` breaks into steps, executes sequentially via `runAgentLoop` | Done |
| **Scheduler** | `bare-agent Scheduler` → `/remind`, `/cron`, `/jobs`, `/cancel`. Persists to `scheduler.json`, 60s poll | Done |
| **Human checkpoints** | `bare-agent Checkpoint` → `src/bot/checkpoint.js`. Prompts yes/no before dangerous tool calls (default: `exec`). 60s timeout | Done |
| **Retry + Circuit Breaker** | `bare-agent Retry` + `CircuitBreaker`. Configurable via `config.llm.retry` and `config.llm.circuit_breaker` | Done |
| **Agent loop** | `bare-agent Loop` → `runAgentLoop()` in `handlers.js`. LLM → tool_use → execute → loop (max 5 rounds, configurable) | Done |

All bare-agent integrations are thin wrappers — `scheduler.js`, `checkpoint.js`, `provider-adapter.js` each <50 lines.

**Deferred (nice-to-have):**
- Heartbeat — cron covers 80% of ambient awareness use cases
- Hooks — only if dogfooding demands event-driven extensibility

**Explicitly skipped:** Message bus (one agent, one process), A2A protocol (no external agents), stream bus (chat is the UI), gateway (daemon IS the gateway). These solve multi-tenant platform problems, not personal assistant problems.

### Tier 3: Multi-Agent Orchestration (not planned)

Broadcast groups, agent handoffs, parallel execution with result merging. Only relevant if multis becomes multi-tenant. Use A2A protocol (Google → Linux Foundation) if ever needed — don't invent a custom agent-to-agent bus.

### Other Future Enhancements

**`fetch_url` Tool** — Lightweight web lookup for the agent loop. Vanilla `https.get` + HTML-to-text (~30 lines). Agent calls it when KB has no match but an answer might be on a known URL (pricing page, FAQ, docs). Covers 90% of web lookup needs without heavy deps. If JavaScript rendering or interaction is ever needed, upgrade path is mcprune/Playwright (400MB Chromium, full browser automation). Start lightweight, escalate only if fetch proves insufficient.

**Agent Handoffs** — `@billing` mention triggers handoff with context summary. Post-dogfood.

**Concurrent Tasks** — Async task queue for long-running ops. Tool returns `{ status: 'async', taskId }`. Post-dogfood.

**Per-Agent Tool Restrictions** — `"allowed_tools"` / `"denied_tools"` in agent config. ~30 lines in tools/registry.js.

**Shared Context Across Chats** — Cross-chat timeline at `user:<userId>/context.md`. ~60 lines in memory/manager.js.

---

### 16. Proactive Agent Tiers

Three tiers of proactive behavior, from simple to autonomous.

**Tier 1: Agentic Reminders (DONE)**

`/remind` and `/cron` accept `--agent` flag. When a job fires with `agentic: true`, the tick handler runs `runAgentLoop` instead of sending plain text. The agent has the owner's full toolset (search docs, recall memory, exec, etc.) and sends the result to the originating chat.

- Jobs store `chatId` and `platformName` — resolved at fire time, not from closure
- Agentic jobs always run as owner (only owner can create them)
- Memory/RAG context loaded for the job's chatId at fire time
- Max 5 tool rounds (configurable via `config.llm.max_tool_rounds`)
- Errors caught per-job, logged, sent to chat as "Job [id] failed: ..."
- Backward-compatible: old jobs without `agentic` field fall back to plain text

```
/remind 2h check inbox                    → plain text
/remind 2h summarize today's messages --agent  → agentic
/cron 0 9 * * 1-5 morning briefing --agent     → daily agentic job
```

Key files: `src/bot/scheduler.js` (parsing), `src/bot/handlers.js` (`createSchedulerTick`, `routeRemind`, `routeCron`).

**Tier 2: Watch Triggers (future)**

Event-driven jobs that fire on external signals, not just time:

- **File watcher** — `fs.watch` on a path, fires agent when file changes
- **HTTP webhook** — stdlib `http.createServer` on a local port, fires on POST
- **Polling** — cron + `fetch_url`, fires when content changes (diff-based)

Each trigger type creates a job with `type: 'watch'` and a `trigger` config object. Same tick handler — just different scheduling mechanism.

**Tier 3: Background Agent (future)**

Self-directed periodic review with task persistence:

- StateMachine for task lifecycle (pending → active → done → archived)
- Meta-prompt: "review pending tasks, check for anything needing attention"
- Mandatory checkpoint for outbound messages (no unsupervised sends)
- Runs on configurable interval (e.g., every 4 hours during active hours)
- `config.background_agent.enabled`, `interval_hours`, `active_hours`, `checklist`
