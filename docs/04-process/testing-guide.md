# Testing Guide

> Last updated: 2026-02-23 | 376 tests | 0 failures

## Running Tests

```bash
npm test                                # full suite (unit + integration)
node --test test/*.test.js              # unit only
node --test test/integration/*.test.js  # integration only
node --test test/beeper.test.js         # beeper platform only
```

## Test Pyramid

```
        /\
       /  \      E2E: 0 tests
      / -- \     Manual smoke test only (see below)
     /      \
    / ====== \   Integration: 62 tests
   / ======== \  Handler pipeline, CLI, SQLite smoke
  / ========== \
 / ============ \  Unit: 195 tests
/________________\ PIN, injection, config, store, memory, cleanup, activation, governance, parsers, beeper
```

**Current ratio: 195 unit / 62 integration / 0 automated e2e**

This is the right shape for a single-user local tool. The integration layer catches wiring bugs (like the `escalationRetries` closure bug found during initial test writing). E2E is manual until we ship to others.

---

## Unit Tests (195 tests, 28 suites)

All in `test/*.test.js`. Each tests a single module in isolation.

### `test/security.test.js` — 27 tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| hashPin / verifyPin | 6 | SHA-256 hashing, round-trip, coercion |
| PinManager.isEnabled | 3 | Config presence/absence |
| PinManager.needsAuth | 5 | No PIN, fresh session, expired, locked |
| PinManager.authenticate | 7 | Correct/wrong PIN, lockout after 3, clear on success |
| Pending commands | 3 | Store, clear, 5-minute expiry |
| detectInjection | 16 | All 12 regex patterns + negatives + multi-match |
| logInjectionAttempt | 1 | Smoke test (writes to real audit path) |

### `test/activation.test.js` — 4 tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| ACT-R activation | 4 | computeActivation (ln(1+sum)), recordAccess, batch recordSearchAccess, BM25+activation blending |

### `test/store-scope.test.js` — 4 tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| DocumentStore scope | 4 | Schema migration (adds scope column), saveChunk with scope, scoped FTS5 search, DocChunk scope field |

### `test/config.test.js` — 9 tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| loadConfig defaults | 9 | Security defaults merge, business.escalation defaults, memory defaults, platforms block, telegram token sync, isOwner, generatePairingCode |

### `test/cleanup.test.js` — 5 tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| cleanupLogs | 3 | Delete old logs, missing dir, skip non-date files |
| pruneMemoryChunks | 2 | Delete old conversation chunks, no-op when empty |

### `test/memory-prune.test.js` — 7 tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| ChatMemoryManager | 12 | pruneMemory, countMemorySections, updateProfile, admin shared path, manager cache, trimRecent, shouldCapture |
| runCapture + runCondenseMemory | 4 | LLM summary indexed with scope, skip "no notable", stage 2 condense to DB, no-op under threshold |

### `test/governance.test.js` — 14 tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| isCommandAllowed | 8 | Allowlist, denylist, not-in-allowlist denied, denylist wins, requireConfirmation, whitespace trimming |
| isPathAllowed | 6 | Allowed path/subdirectory, denied path/subdirectory, denied priority over allowed, not-in-any-list |

### `test/parsers.test.js` — 20 tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| getParser | 6 | Routing per extension (.md/.txt/.pdf/.docx), unsupported returns null, uppercase extensions |
| parseMD | 5 | Heading extraction, sectionPath hierarchy, sectionLevel, content text, no-headings fallback |
| parseTXT | 3 | Single chunk, empty file → [], elementType paragraph |
| parsePDF | 3 | Text extraction from real PDF fixture, filePath set, DocChunk instances |
| parseDOCX | 3 | Text extraction from programmatic DOCX, heading hierarchy, no-headings fallback |

Test fixtures in `test/fixtures/`: `sample.md`, `sample.txt`, `sample.pdf` (LibreOffice-generated), `empty.txt`, `no-headings.md`. DOCX fixtures built at test time via minimal ZIP constructor.

### `test/beeper.test.js` — 41 tests

| Suite | Tests | What it covers |
|-------|-------|----------------|
| constructor | 3 | Default URL/poll/prefix, custom config, initial state (empty selfIds/lastSeen) |
| _loadToken | 3 | Load from ~/.multis/auth/beeper-token.json, missing file → null, malformed JSON → null |
| _isSelf | 3 | senderID match, unknown sender, fallback to `sender` field |
| _getChatMode | 3 | Default personal, config default_mode, per-chat override |
| send | 1 | Prefixes outgoing messages with `[multis]` |
| start | 3 | No token → abort, API failure → abort, populates selfIds from accounts |
| stop | 1 | Clears poll timer |
| _seedLastSeen | 3 | Seeds lastSeen from message IDs, detects personal/self chats, API error graceful |
| _poll | 11 | Skip when not initialized, route self // commands, natural language in personal chats, business mode routing, ignore non-self personal, skip [multis] cascade, dedup via lastSeen, oldest-first ordering, lastSeen update, normalized Message fields, handler error resilience, poll error suppression + clear |
| Message (beeper) | 7 | isCommand (self/non-self/plain), commandText strip //, parseCommand extract, non-command → null |

Uses temp HOME directory with mocked `_api` method — no real HTTP calls needed.

---

## Integration Tests (62 tests, 17 suites)

All in `test/integration/`. Exercise real wiring between modules.

### `test/integration/handlers.test.js` — 42 tests

Tests the `createMessageRouter` pipeline end-to-end with mock LLM, mock platform, and stub indexer.

| Suite | Tests | Key paths exercised |
|-------|-------|-------------------|
| Pairing | 4 | /start valid/invalid/missing code, already paired |
| Command routing | 5 | /status, /help, /search empty, owner-only rejection, unpaired rejection |
| RAG pipeline | 4 | /ask with chunks, no LLM configured, scoped search (admin vs non-admin) |
| PIN auth | 3 | Prompt → correct PIN → execute, wrong PIN + attempts, locked account |
| Business escalation | 3 | Keyword → immediate, retries → escalate, success → reset counter |
| Injection detection | 2 | Flagged but still answered, admin bypasses |
| Memory commands | 2 | /remember → /memory → /forget lifecycle, /remember no args |
| Owner commands | 7 | /exec governance, /read file, /index scope enforcement, missing args |
| Search with results | 2 | Result formatting, non-admin scope filtering |
| Info commands | 2 | /docs stats, /skills listing |
| Unpair | 1 | Removes from allowed_users |
| Beeper routing | 3 | // prefix, routeAs natural → /ask, non-self ignored |
| Help visibility | 2 | Owner sees exec/read/index, non-owner doesn't |
| Natural language routing | 2 | Paired → ask, unpaired → silent |

**Production change required**: `createMessageRouter(config, deps = {})` accepts optional dependency injection. Zero change to existing callers.

**Bug found during test writing**: `escalationRetries` was used in `executeCommand()` but never passed as a parameter — it was a closure variable in `createMessageRouter` but `executeCommand` is a module-level function. Fixed by adding it as an explicit parameter.

### `test/integration/cli.test.js` — 7 tests

Tests the `bin/multis.js` CLI as a subprocess with isolated `$HOME`.

| Test | What it covers |
|------|----------------|
| No args | Prints usage |
| Unknown command | Exits 1 |
| Status (no PID) | Says "not running" |
| Stop (no PID) | Says "not running" |
| Start (no config) | Says "run init", exits non-zero |
| Doctor | Runs all checks, reports results |
| Stale PID | Detects dead process, cleans up PID file |

### `test/integration/sqlite-smoke.test.js` — 13 tests

Real SQLite + FTS5, no mocks. Catches schema drift between migrations and queries.

| Suite | Tests | What it covers |
|-------|-------|----------------|
| Store layer | 7 | Save/retrieve chunk, FTS5 search, scope filtering (kb/admin/user), user isolation (Alice vs Bob), ACT-R activation on access, getStats, deleteByFile clears FTS |
| Indexer + real files | 6 | Index .md and .txt, scoped search, re-indexing idempotency, indexBuffer for uploads |

---

## E2E / Manual Tests (0 automated)

### Manual Smoke Test Checklist

Run once per POC, takes ~5 minutes:

```
[ ] multis init — wizard completes, config.json written
[ ] multis start — daemon starts, PID file created
[ ] multis status — shows running PID
[ ] Telegram: /start <CODE> — pairs as owner
[ ] Telegram: /status — shows bot info, role: owner
[ ] Telegram: /ask <question> — LLM responds with context
[ ] Telegram: /exec ls — PIN prompt → enter PIN → output
[ ] Telegram: /index ~/test.pdf kb — indexes, reports chunks
[ ] Telegram: /search <term> — finds indexed content
[ ] Telegram: /remember <note> → /memory → /forget
[ ] Telegram: send a PDF file — auto-indexed
[ ] multis stop — daemon stops cleanly
[ ] multis doctor — all checks pass
```

### When to Automate E2E

Not now. Automate when:
- **Model C (self-hosted for businesses)**: create a test bot token, script that sends messages via Telegram Bot API, asserts replies
- **Beeper integration goes live**: test `//` commands via Desktop API mock server
- **CI/CD pipeline added**: e2e as a nightly job, not on every commit

---

## Coverage Analysis

### Well-Covered (high confidence)

| Area | Unit | Integration | Notes |
|------|------|-------------|-------|
| PIN auth | 20 | 3 | Full lifecycle: enable, prompt, auth, lockout, session expiry |
| Injection detection | 17 | 2 | All patterns + admin bypass + still-answers behavior |
| Scope filtering | 4 | 5 | SQL-level enforcement, user isolation, admin unrestricted |
| Config loading | 9 | — | Default merging, all config blocks |
| Command routing | — | 14 | Every command path through createMessageRouter |
| Business escalation | — | 3 | Keywords, retry threshold, counter reset |
| SQLite + FTS5 | 4 | 13 | Schema, CRUD, search, activation, re-index, triggers |
| Memory lifecycle | 7 | 2 | Prune, capture, /remember → /memory → /forget |
| CLI | — | 7 | All subcommands except init (interactive) |
| Governance | 14 | — | Allowlist, denylist, path validation, priority rules, confirmation |
| Parsers | 20 | — | All 4 formats (MD/TXT/PDF/DOCX), heading hierarchy, edge cases |
| Beeper platform | 41 | 3 | Token loading, self detection, chat modes, polling, message routing, dedup, ordering, cascade prevention |

### Gaps (known, acceptable)

| Area | Risk | Why not tested | When to add |
|------|------|---------------|-------------|
| `multis init` wizard | Low | Interactive readline, hard to automate | Extract `createConfig(answers)` if it breaks twice |
| Telegram adapter | Low | Thin wrapper over Telegraf, tested by library | When upgrading Telegraf versions |
| Beeper live HTTP | Low | 41 unit tests cover all logic via mocked _api; no live HTTP tests | Add mock HTTP server if API contract changes |
| Real LLM round-trip | Low | Costly, flaky, provider-dependent | Nightly CI job in Model C |
| PDF/DOCX edge cases | Low | Basic parsing tested; complex layouts (tables, images, nested lists) untested | Add if parsing bugs appear with real documents |
| Governance via handler | Low | Handler calls `execCommand` which uses real governance file | Inject governance into executor if needed |
| Document upload (Telegram) | Low | Requires telegram.getFileLink mock | When upload bugs appear |
| Capture fire-and-forget | Low | Async, hard to assert timing | Tested at unit level (runCapture) |
| Concurrent access | Low | Single-user, single-process | Not applicable until multi-user |

### Recommended Next Tests (by priority)

**~~1. Governance testability~~** — DONE (14 tests in `test/governance.test.js`)

**~~2. PDF/DOCX parser smoke tests~~** — DONE (20 tests in `test/parsers.test.js`)

**~~3. Beeper platform tests~~** — DONE (41 tests in `test/beeper.test.js`)

**1. Error recovery** (~30 min)
- LLM throws mid-response → error message sent to user
- SQLite DB locked → graceful failure
- indexFile on nonexistent path → error message

---

## Test Infrastructure

### `test/helpers/setup.js`

Four helper functions, no classes:

```js
createTestEnv(overrides)  // temp HOME + config.json + governance.json
mockPlatform()            // records sent messages, lastTo(chatId)
mockLLM(response)         // canned response, tracks calls
msg(text, overrides)      // creates a Message object for testing
```

### `stubIndexer(chunks)` (in handlers.test.js)

Inline helper — records search calls, returns configured chunks. Tracks `searchCalls` for scope verification.

### Conventions

- `node:test` built-in runner (no Jest/Mocha)
- `node:assert` for assertions
- Temp directories with `fs.mkdtempSync`, cleaned up in `after()`
- No test-only code in production modules (DI via optional params only)
- Tests are independent — no shared state between describe blocks
