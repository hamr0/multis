# PRD — multis → baresuite migration

**This is the sole guiding document for the migration.** Every POC, lib-feedback round, and module ships against this doc. It supersedes `docs/04-process/baresuite-migration.md` (removed).

**Status:** Active · **Owner:** hamr0 · **Created:** 2026-06-15
**Baseline:** multis v0.14.0 — `bare-agent ^0.10.2`, `bareguard ^0.4.2`, no litectx, homegrown memory + indexer.
**Target:** multis as the **first real customer of the full baresuite** — `bare-agent 0.16`, `bareguard 0.7`, `litectx 0.16` (memory **and** context-engineering), beeperbox-swappable Beeper. Every homegrown agent primitive retired.

---

## 1. Goal

Two goals, equal weight:
1. **Finish multis** as a real product (local-first chatbot/assistant for personal + small-business use, Telegram + Beeper).
2. **Validate the baresuite by consuming it for real.** multis is the dogfood that proves — and grows — bareagent, bareguard, litectx, beeperbox.

---

## 2. Principles (govern every module)

1. **No papering over.** If a job belongs to a lib and the lib can't do it yet, **push the lib to grow/change** — never shim, wrap, or re-implement inside multis. A discovered gap is a *stop-and-file* event, logged in §7.
2. **multis changes only for multis's job** — domain mapping, policy, platform glue, UX.
3. **Rebuild, don't refit.** Homegrown code a lib now owns is **deleted and rebuilt bottom-up on the lib**, not adapted behind an interface. Setup/config/CLI/tools/platform adapters stay.
4. **POC by POC, always waiting for the lib.** Each module is a POC aimed at its *riskiest assumption* (per `AGENT_RULES.md`). If the POC exposes a lib gap → file it → **wait for the lib to adjust** → resume. No leaping ahead.
5. **Sequential, logical building blocks.** Foundation libs current before building on them; substrate (index) before memory; memory before context-engineering. Never start a block whose dependency isn't green.
6. **Simplify as we go.** Pre-existing multis design is not sacred. Any module may propose dropping bloat toward simpler/no-bloat — questioning the design is encouraged, on both sides. Recorded in §6.
7. **Prove, don't assert.** A module is "done" only with a passing validation gate (§ per-module). Measure anything called cheap/fast.
8. **Stay in multis's lane.** This work touches **multis only**. When a finding belongs to a lib, the deliverable from here is a **clear, written ask** in §7 — exactly what that lib must change and why — not a fix authored from multis. Each repo carries its own work; I do not edit lib source, file issues in lib repos, or design a lib's internal solution. Consumer-level integration against a lib's **public API** (wiring + a POC to see if the surface already suffices) is in-lane; reading lib internals to author their fix is not. If multis's part is blocked on a lib ask, multis **waits** (Principle 4).

---

## 3. The working loop (per module)

```
pick next module (deps green)
  → POC the riskiest assumption against the real lib
      → lib does the job?  ── yes ─→ build clean (delete homegrown, rebuild lib-native)
      │                     ── no  ─→ file upstream ask (§7) ─→ WAIT for lib release ─→ re-POC
      → validation gate green (suite + smoke→CI + any manual round-trip)
      → ship module ─→ next
```

We do not batch modules. One block at a time, each green on its own before the next.

---

## 4. Decisions

### Locked
- **§A Per-chat isolation — shared litectx DB + `owner`/`session` scopes.** One DB; `kb → global` (owner NULL), `user:<chatId> → owner=<chatId>`, `admin → owner='admin'`. (Enables cross-chat admin/kb; it's what scopes are for.)
- **§B Capture — B2 (pure promotion ladder) + explicit `/remember` direct fact-write.** Passive usefulness-weighted memory via litectx's ladder; active instant memory on command. Retires the homegrown LLM summarize/condense pipeline entirely. *Expected: leans on litectx ladder (slice 5b); M4 may block on a litectx release — that wait is the validation, not a problem (Principle 4).*
- **§C Recall — C1 (host-side injection) now, C2 (recall/impact as LLM tools via MCP) opt-in later.** Cheap, predictable, one round per turn; agentic recall added additively once the substrate is stable.
- **§D PDF/DOCX — litectx ingests + chunks.** If a format/chunking falls short, **litectx changes** (Principle 1); only if we decide the format isn't worth litectx owning do we reconsider. multis does **not** keep a parallel parser path as a workaround.

> All four locked. A module blocking on a lib release is an expected, accepted outcome — it is the lib-validation working as intended (Principle 4), not a schedule risk to engineer around.

---

## 5. Ownership map (post-migration end state)

| Code today | Job | Action |
|---|---|---|
| `src/memory/*` (recent.json → memory.md → FTS5 → ACT-R) | **litectx** | rip out, rebuild |
| `src/indexer/*` (FTS5 store, chunking) | **litectx** | rip out, rebuild |
| prompt/context assembly (`prompts.js`, no budget-fit) | **litectx CE** | build fresh |
| `runAgentLoop` wrapper | **bare-agent Loop** | thin toward zero |
| `provider-adapter.js`, `scheduler.js`, `checkpoint.js`, retry/CB | **bare-agent** | keep thin, restate on current API |
| `buildGateConfig`, action translator, owner model | **multis** (domain→gate) | keep, clean only |
| `governance/audit.js` (app events) | **multis** | keep |
| `tools/definitions.js` | **multis** | keep |
| `platforms/*` | **multis** | keep; beeper endpoint configurable |
| PIN/security, escalation, modes, business persona | **multis** | keep |

---

## 6. Module breakdown

Each module: **Goal · Riskiest assumption (POC) · Remove · Build clean · Ownership · Upstream watch · Validation gate · Exit.**

### M0 — Validation net *(build first; no lib dep)* ✅ DONE (2026-06-15)
- **Goal:** regression gate so "done" is evidence, not assertion.
- **POC:** can a mock LLM + real `fileless` Gate drive the real router end-to-end?
- **Remove:** nothing. **Build:** `test/e2e/router.test.js`; lift `mockToolProvider` into `test/helpers/setup.js`.
- **Ownership:** multis. **Upstream watch:** —
- **Gate / Exit:** ✅ suite green + e2e cases for smoke steps 5,6,7,8,9,10,11. Net earned its keep immediately — surfaced F1 (slash gate bypass, fixed in-lane), F2, F3.

### M1 — bareguard 0.4.2 → 0.7.0 *(dep: M0)* ✅ DONE (2026-06-15)
- **Goal:** foundation gate current. Assessed additive.
- **POC:** does the existing `buildGateConfig` + governance.test.js pass unchanged on 0.7?
- **Remove:** nothing. **Build:** bump + reinstall.
- **Ownership:** lib. **Upstream watch:** any 0.4-era config silently no-ops → file.
- **Gate / Exit:** ✅ full suite green on the bump. Bonus: F2 (§7) is answered by 0.7.0's `flags` primitive — consumed in the F2 cutover (§8).

### M2 — bare-agent 0.10.2 → 0.16.1 *(dep: M1)* ✅ DONE (2026-06-15)
- **Goal:** foundation loop current; unlock `assemble`/`trim` hooks for M5.
- **POC:** spot-check 3 non-additive items — checkpoint fail-closed (`yes/y/approve` only), `err.body` omitted by default, CLI config requires `gate`.
- **Remove:** dead `maxRounds`-era paths surfaced by the bump. **Build:** bump + reinstall.
- **Ownership:** lib. **Upstream watch:** missing model in loop cost table → file (don't hardcode).
- **Gate / Exit:** ✅ full suite green. Pinned **0.16.1** (the F3 fix release, not 0.16.0). F3 (§7) resolved → real cost-accrual budget-halt e2e replaces the M0 direct-injection scaffold, failability-proven.

### M-B — Beeper endpoint configurable + beeperbox swap *(dep: M0; parallel to M1/M2)*
- **Goal:** decouple Beeper client from local Desktop; validate the **beeperbox** container swap (cheapest full baresuite-customer test).
- **POC:** point multis's Beeper client at a beeperbox container by config and complete one real send/receive round-trip.
- **Remove:** hard-coded `localhost:23373`. **Build:** `config.beeper.baseUrl` (+ token from secret store); no new dependency.
- **Ownership:** multis glue; beeperbox/Beeper own the API. **Upstream watch:** any Desktop-API gap → file against beeperbox.
- **Gate / Exit:** `beeper.test.js` parametrized on base URL; default behavior preserved; beeperbox round-trip recorded in release log; beeperbox documented as optional headless deploy (not bundled).

### M3 — litectx doc index *(dep: M1, M2)* — replaces `src/indexer/*`
- **Goal:** retire homegrown FTS5 + chunking; rebuild `/index` `/search` `/docs` on `LiteCtx`.
- **POC (riskiest):** does litectx ingest + chunk multis's real PDF/DOCX corpus and return usable recall under the §A scope model? (per §D, if not → push litectx, wait.)
- **Remove:** `src/indexer/store.js`, homegrown chunker (and `parsers/` iff litectx ingests the format).
- **Build:** thin `src/index/*` over `new LiteCtx({ root, include, owner, session })`; routes call `index()`/`recall({kind})`/`get()`. Scope mapping per §A.
- **Ownership:** litectx (ranking/chunking/storage). **Upstream watch:** PDF/DOCX ingest, scope semantics, BM25 quality.
- **Gate / Exit:** indexer/parsers tests rebuilt on recall; smoke step 4 green via e2e.

### M4 — litectx memory *(dep: M3)* — replaces `src/memory/*`
- **Goal:** retire recent.json window, memory.md, two-stage condense, ACT-R; rebuild on litectx kinds.
- **POC (riskiest):** does the **promotion ladder** (§B B2) produce the right durable facts from real episode traffic, with §A per-chat scope isolation holding? (co-dev with litectx likely.)
- **Remove:** `memory/manager.js`, `memory/capture.js`.
- **Build:** window → `episode`; durable → `fact`; condense → `promotionCandidates()`; `/memory` `/remember` `/forget` → recall/remember/forget (explicit `/remember` = direct fact-write).
- **Ownership:** litectx (store/ranking/decay/promotion). **Upstream watch:** scope filter, promotion thresholds, recall grouping.
- **Gate / Exit:** memory/recall tests rebuilt; smoke step 12 → e2e where possible.

### M5 — litectx context-engineering *(dep: M4)* — new
- **Goal:** budget-fitting multis never had; close "litectx = memory + CE".
- **POC (riskiest):** does `Loop({assemble,trim})` ↔ litectx `unitAssembler`/`unitTrimmer` keep recency + atomic tool bundles within a token budget on a long chat?
- **Remove:** ad-hoc prompt stuffing in `prompts.js`.
- **Build:** wire hooks via bare-agent `toUnits`/`fromUnits`/`harvestKey`; optional `summaryWindow` for long chats.
- **Ownership:** litectx (budget-fit/compress/harvest). **Upstream watch:** pinning/atomic invariants multis needs.
- **Gate / Exit:** e2e budget-bound + recency cases; ask flow unregressed.

### M6 — thin the loop *(dep: M2, M5)*
- **Goal:** remove multis wrapping bare-agent 0.16 now covers; `runAgentLoop` → near-direct `Loop.run`.
- **Ownership:** bare-agent. **Gate / Exit:** agent-loop integration tests green.

### M7 — writeGate + impact *(optional; dep: M4)*
- **Goal:** cross-lib seams — litectx `writeGate` ↔ the same bareguard Gate; `impact()` before destructive owner actions.
- **Ownership:** lib seam. **Gate / Exit:** e2e deny-on-bad-write case.

---

## 7. Lib feedback log *(append as we go — every upstream ask)*

| Date | Module | Lib | Ask | Status |
|---|---|---|---|---|
| 2026-06-15 | M0 / F3 | bare-agent | `CircuitBreaker.wrapProvider` returns only `{generate}`, dropping `.model`. `Loop` reads `this.provider.model` (loop.js:181) for `estimateCost`, which returns null on a null model → `budget.maxCostUsd` accrues **no** LLM token cost whenever a wrapped provider is used. Two bare-agent primitives compose to silently disable the cost cap. Fix: `wrapProvider` should preserve `model`, or `Loop` should fall back to `result.model`. | **RESOLVED (2026-06-15)** — shipped in **bare-agent 0.16.1**: `wrapProvider` preserves passthrough props, `Loop` falls back to `result.model`, providers emit `model`. multis pins `^0.16.1`; real cost-accrual budget-halt e2e (M2) proves the cap halts, failability-confirmed. |
| 2026-06-15 | F2 | bareguard | **Need a per-tool / per-action-type "always ask" primitive.** multis must route blanket per-tool confirmation (e.g. confirm before **every** `exec`/`bash`) through bareguard's single humanChannel — governance = bareguard, no local drift. **Requirements:** (1) fires on **every** action of the configured type/tool, **not** preempted by an allow decision or silenced by `tools.allowlist`/`bash.allow`; (2) routes through the existing humanChannel as `kind:"ask"` with `event.action` + `event.action._ctx` intact (host routes the prompt back to the originating chat, applies allow/deny/terminate); (3) config-driven, composable with existing deny/ask patterns. **Proposed shape (bareguard's call):** `confirm:{ types:['bash'] }` or `bash:{ ask:true }` / `fs:{ ask:true }`, **or** confirm `flags`-ask is the intended mechanism and document correct usage. **Consumer repro (didn't fire):** minimal gate `flags:{ confirm:{ yes:'ask' } }` + action `{ type:'bash', args:{command:'ls'}, confirm:'yes' }` → `check` returned `allow`, humanChannel never called. (Stated as observation; bareguard to confirm usage or provide the primitive.) **Acceptance:** a configured always-ask type invokes humanChannel (kind `ask`) for every such action; `_ctx` preserved; deny blocks, allow proceeds. | **RESOLVED (2026-06-15)** — no new primitive: the existing `flags` primitive (bareguard ≥0.6.0, present in 0.7.0) is the mechanism. `flags:{type:{bash:'ask'}}` fires at step 4b before the allowlist; the repro failed only on 0.4.2 (pre-`flags`). All acceptance criteria proven against the published `Gate` (with negative controls). Consumed in the F2 cutover (§8). |

---

## 8. Design-simplification register *(things we questioned and changed)*

| Date | What | Decision |
|---|---|---|
| 2026-06-15 | LLM-summarize capture pipeline | Retire (§B B2 locked) — usefulness-weighted promotion ladder + explicit `/remember` instead |
| 2026-06-15 | **Slash `/exec` `/read` bypassed the gate** (M0 finding) | FIXED — `routeExec`/`routeRead` now run the same `gov.resolve().policy` as the LLM tool path. governance = bareguard on every privileged entry point. Multis wiring (Principle 2). |
| 2026-06-15 | **Checkpoint is a parallel approval path** (F2, M0 finding) | **DONE (2026-06-15)** — cutover executed. `config.security.checkpoint_tools` → `flags:{type:{<gateType>:'ask'}}` in `buildGateConfig` (default `['exec']`); Checkpoint wiring removed from `runAgentLoop`; checkpoint reply path + `bot/checkpoint.js` deleted; confirmation flows through the single `humanChannel`. `buildGateConfig` now composes `SAFE_DEFAULT_ASK_PATTERNS` (was clobbering). **Behavior change (intended):** slash `/exec` now also asks (was LLM-path only) — uniform governance. Proven at three levels (primitive POC + wiring tests + mutation/failability). |

---

## 9. Definition of done (whole migration)

- No homegrown memory, indexer, or context-assembly code remains; all on litectx.
- `bare-agent 0.16`, `bareguard 0.7`, `litectx 0.16` pinned.
- Every "lib's job" subsystem is lib-native, not a shim; every gap found is filed (§7), not patched in multis.
- Smoke steps 4,5,6,7,8,9,10,11,12,13 run in CI via the M0 net.
- Beeper works unchanged against local Desktop **and** against beeperbox by config alone (M-B round-trip recorded).
