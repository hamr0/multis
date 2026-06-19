# Changelog

All notable changes to multis. Pre-stable (0.x) — versions track feature milestones, not releases.

## [Unreleased]

### Security — pre-merge gate: shell-injection class closed in the agent tools

A `/security` + `/diff-review` pass before merging the migration branch found and fixed a **command-injection / gate-bypass** class in the LLM agent tools:

- **`find_files` / `grep_files` (HIGH, proven RCE).** Both built a `bash` string by interpolating LLM-supplied args via `JSON.stringify`, which escapes `"`/`\` but **not** `$` or backticks — so `name: "$(…)"` or a `;`-laden `options` executed arbitrary shell. Because these tools translate to a `read` action at the gate, the dangerous string never reached bareguard's shell-metachar deny — a full bypass of command governance, reachable via prompt injection on the owner/agent path. Proven live (red), fixed, re-proven (green). **Fix:** a new no-shell `execArgv(file, args)` (argv via `execFile`) in `src/skills/executor.js`; `find`/`grep` now pass argv, so `$()`/`;`/backticks are inert literals. `--` terminates grep flags.
- **Desktop tools hardened (`open_url`, `notify`, `wifi`, `clipboard`, `screenshot`).** Same `JSON.stringify`-into-shell pattern. Single-command tools moved to `execArgv` (no shell); the two that genuinely need a shell (clipboard pipe, screenshot `||` fallback) use a single-quote escaper `shq()`. Regression tests assert `$()` stays inert across all of them.
- **PIN-resume dependency fix.** After a correct PIN, the resumed command was handed the `memoryManagers` Map in the `getMem` slot and dropped `platformRegistry` — a latent crash for PIN-gated `/ask`/`/remember`. Now matches the normal dispatch path.

### Removed — Termux / Android device-control tools

The 11 Android-only Termux tools (`phone_call`, `sms_send`, `sms_list`, `contacts`, `location`, `camera`, `tts`, `torch`, `vibrate`, `volume`, `battery`) are removed, along with Android platform detection, the `android-setup.md` guide, and `scripts/setup-termux.sh`. They were a deferred aspiration (phone control from a Termux-hosted bot) that never shipped in practice; multi-platform reach is delivered by beeperbox instead. The cross-platform tools (`open_url`/`notify`/`clipboard`/`system_info`) drop their `termux-*` branches; `getPlatform()` now returns `linux`/`macos` only.

### Changed — `/help` redesigned (grouped by intent, role-aware, progressive disclosure)

`/help` was a flat ~25-line wall built by splicing owner commands into a base list — alphabetical-ish, with the same `/mode` listed twice (once as the mode setter, once as the business menu). Replaced with a single command catalogue (`HELP_COMMANDS`) rendered **grouped by intent** — **ASK** (find answers) · **REMEMBER** (build memory & knowledge) · **SCHEDULE** (do things later) · **RUN** (act on this machine) · **MANAGE** (configure the bot) — and **filtered to the viewer's role** (`all` / `admin` / `owner`), so a customer sees only Ask + personal memory + status, a limited admin adds `/index` + `/mode`, and the owner sees everything. `/mode` now appears **once**. Adds **progressive disclosure**: `/help <command>` returns that one command's usage + detail (e.g. `/help mode` explains the business menu and silent/off semantics); an unknown or not-permitted topic falls back to the full menu with a nudge (and an owner-only command's detail is never disclosed to a non-owner). One metadata table now drives both views — no more splice-wall drift. 519/519 green; grouping, the `/mode` dedup, role-filtering, and the detail/fallback paths are covered by tests.

### Changed — router pending-state de-tangle (unified PendingRegistry)

The router's "the next message is special" handling had grown into **three parallel, drifting subsystems** — `pinManager.pendingCommands` (PIN entry), human-channel's `pendingHumanResponses` (gate approval/PIN/CONFIRM), and five `config._pending*` objects (admin/index/mode/business-menu/wizard) — each with a different key (a mix of `senderId` and `chatId`), a different TTL (or none), and its own dispatch check at the top of the router. Two real bugs fell out: a PIN reply arriving **after the prompt lapsed** fell through to the RAG pipeline as a *search query* (or was silently dropped), and a reply could be consumed by the wrong pending challenge. Replaced with one store — `src/bot/pending.js` `PendingRegistry`: keyed by the `chatId:senderId` tuple, uniform TTL, **announce-on-expiry**, payload-agnostic so both stored-continuations and parked-promise challenges share it. All four phases now complete:

- **PIN command-entry + pin-change** onto the registry; the dead `PinManager` pending methods removed. A late PIN reply now gets *"PIN entry expired — please re-send the command."* instead of becoming a query. The `chatId:senderId` key also removes the cross-chat / Beeper senderId-drift collisions of the old `senderId`-only mix.
- **The three gate challenges** (approval / PIN / CONFIRM) onto the registry; `pendingHumanResponses` + `handleHumanReply`/`hasPendingHumanReply` + the separate dispatch path deleted. The router top is now a single `pending.get()` + `switch(entry.kind)`.
- **Two concurrency hazards fixed** while here (both pre-existed in the old code): a displaced parked challenge was silently *orphaned* (hung to its own timer) — `set()` now resolves it `null` on overwrite; and two near-simultaneous correct PINs could *double-run* the command (the get→clear window spanned an `await`) — the entry is now claimed synchronously before the first await, with wrong-PIN retry preserved.
- **The five `config._pending*` pickers** (admin / index / mode / business-menu / business-wizard) onto the registry as `switch` cases, and the old per-picker dispatch blocks + `config._pending*` scaffolding deleted. Each picker keeps its own cancel contract: a `/command` cancels the picker and falls through to normal routing; a mode picker's non-numeric reply still re-prompts; an index picker's non-`[123]` reply still drops silently. Pickers now also get **announce-on-expiry** (a late numeric reply is announced as expired, not forwarded to RAG) and a TTL — single-sourced from a new `config.interaction` block (`picker_ttl_minutes: 5`, `wizard_ttl_minutes: 30`, the longer window for the multi-step wizard). Pending pickers are **in-memory only** — a half-finished picker is intentionally dropped on restart. One latent hazard closed for free: with a single entry per `(chat,sender)` the latest prompt is authoritative, so a numeric reply meant for the mode picker can no longer be swallowed by a still-open index prompt.

Behavior-neutral for the live flows (the full picker suite stayed green across the migration); the orphaned-reply, double-execute, displaced-waiter, and picker announce-on-expiry behaviors are each red→green mutation-proven. 514/514 green.

### Changed — dispatch/agent rewrite (obedient-bot-first)

Live dogfooding ("find me X on my laptop") kept failing. Temporary timestamped instrumentation (`src/debug/instr.js`, an event-loop-lag monitor + phase marks, on by default, `MULTIS_INSTR=0` to silence) **pinned the cause** — and it was *not* the intermittent beeperbox 15 s timeout (that never reproduced across the dogfood; the earlier `execSync`→async-`exec` fix appears to have cleared the common case, and the instrumentation stays armed for the rest). The real cause was the prompt/governance wiring. Fixes, all behind 493/493 green:

- **Persona no longer shadows the tool-use prompt.** `buildMemorySystemPrompt` composed the system prompt as `persona || SYSTEM_PROMPT`, so a configured agent persona (e.g. *"You are a helpful personal assistant."*) **replaced** the base prompt that tells the model it has tools — the model then deflected ("I don't have access to a database") and guessed out-of-scope paths that the gate denied, surfaced to the user as a false "I don't have permission". The owner/natural path now always runs the obedient base prompt; persona/constitution is **deferred** to the memory/litectx module (business mode keeps its customer-facing persona). The base prompt is rewritten to be an *obedient* bot: the owner's messages are orders, USE the tools immediately, never claim a lack of access before trying, search instead of guessing a path, and report the real tool error.
- **Owner has full machine access.** `governance.paths` is now `allowed:["/"]`, `denied:[]` — the owner can read/find/grep anywhere (single-owner model: customers never get host tools, gated at `ownerCheck`). Previously a narrow `~/Documents,~/Downloads,…` read scope denied `~/Music`, `/stuff`, etc., which is what broke "find my music".
- **Pasted paths are no longer mis-parsed as commands.** A new `looksLikeCommand` (`/help`, `/ask x`) distinguishes a command from a pasted path (`/home/hamr/resumes/`); a path now routes to the agent as natural language instead of parsing as an unknown command and being silently dropped.
- **Unknown commands reply** (`Unknown command: /x — try /help`) instead of silently no-opping.
- **Halt prompt clarity.** A tool-round-cap halt now renders as a plain *"⚠️ Stopped — I took too many tool steps … try rephrasing"* and **terminates immediately** instead of waiting 60 s on a meaningless "yes to terminate / no to deny" (the old shape also caused a needless `humanChannel` 60 s timeout on every cap halt).

**Still in flight (next passes):** the router pending-state-machine de-tangle is now complete (all four phases — see the *unified PendingRegistry* entry above). Persona/constitution/facts return with the litectx memory module.

### Changed — command governance (3-tier: benign / destructive→PIN / catastrophic→PIN+CONFIRM)

Live dogfooding ("find my music folder and list the subdirs") demanded a PIN for a benign `ls`, then the prompt expired (120 s) and the reply got treated as a new question. The old model PIN-gated **every** `exec`/`read_file` and **hard-denied** the whole denylist. Replaced with an obedient, tiered model (owner-authorized; single-owner — customers still never get host tools, gated at `ownerCheck`):

- **Benign** (allowlisted commands, all reads/finds) → **just run**, no PIN, no prompt. `ls ~/Music` works.
- **Destructive** (the denylist: `rm`, `mv`, `chmod`, `chown`, `kill`, `sudo`, `dd`, …) → **PIN**, then runs. No longer hard-denied — the owner can do it with a PIN.
- **Catastrophic** (a tiny explicit set: `rm -rf` of `/` `~` `/*`, `dd` to a device, `mkfs`/`wipefs`, redirect to a block device, fork bomb, `shutdown`/`reboot`) → **PIN + a typed `CONFIRM`**, then runs. A deliberate speed bump against a fat-fingered disaster; never a hard wall.
- The blanket always-ask on `exec` (`checkpoint_tools`) is now **opt-in** (default `[]`); the PIN prompt **timeout is 5 minutes** (was 2); reads are no longer PIN-gated now that the owner's fs scope is open.

New `createConfirmChallenge` (typed-CONFIRM tier) in `human-channel.js`; tier detection (`isCatastrophic`/`makeDestructiveCheck`) in `gate.js`, unit-tested per pattern. 500/500 green.

### Fixed — `find_files` missed name+extension

`find_files` ran `find -name <exact>`, so "amr-hassan-resume" never matched `amr-hassan-resume.txt`. Now case-insensitive substring by default (`-iname "*<name>*"`), explicit globs honored as-is, depth 5→6. Proven red→green against the real file.

### Changed — `multis init` wizard

- **Branched setup flow.** Step 1 now asks the two real questions separately instead of a flat 3-item list: first **what** (Personal assistant / Business chatbot), then **how to run it**, branched by that choice. Personal → *Your personal bot* (Telegram only) or *Personal bot + messenger assistant* (Telegram + Beeper, all messengers). Business → runs through Beeper (a Telegram bot can't see your real contacts), with an opt-in "also add Telegram as a backup admin channel?".
- **Owner guidance now matches the path — fixes a stray pairing code.** The end screen previously printed "Pairing code … send /start to your bot" whenever `owner_id` was unset, including Beeper-only setups that have no bot to pair with. Now: Telegram paths show the pairing code; Beeper paths show *"you're the owner via your Note-to-self chat"* (per the `isSelf && isPersonalChat` model); both can show when both are enabled.
- **beeperbox auto-detect.** The Beeper step probes `localhost:23375` first; if a beeperbox is already running it shows the account count + labels and offers to adopt it (Enter = yes, or paste a different URL), skipping the URL **and** token prompts. The MCP-token prompt now appears only for a remote/manual endpoint and explains what the token is (its `MCP_AUTH_TOKEN`), that loopback needs none, and that it is **not** the Beeper Desktop `BEEPER_TOKEN`.
- **Config written with secure perms.** `init` now saves `config.json` via `saveConfig`, so it lands `0600` and `~/.multis` `0700` immediately (it holds the PIN hash, LLM API key, and bot/MCP tokens). Previously the wizard's raw `writeFileSync` left a secrets-bearing config world-readable (`0644`) until some later save repaired the mode.
- **No false "keep current" on first run.** The Enter-to-keep prompt now appears only when a real saved `config.json` existed — a true first run (template defaults only) no longer offers to "keep" a setup that was never saved.

### Docs

- **LIVE‡ verification run-sheet** (`docs/01-product/baresuite-migration-live-verification.md`) — the PRD §10 merge gate (the `LIVE‡` security rows: C1, A1–A3, SEC1–SEC6, SEC9–SEC10, plus SEC11–SEC12 spot-checks) turned into an ordered, copy-paste checklist with exact commands, grounded expected output (real reject strings, config knobs, audit signals), and a sign-off table. Makes the manual pre-merge pass mechanical.
- **README rewrite** — reframed to the product's actual scope (a local-first chatbot/assistant for **personal *and* small-business** use), marked **`[WIP]`** with a `Status` section, and added a *Connects to* (today / planned) list. **Connection modes simplified to three** — Telegram, beeperbox-local, beeperbox-remote (the old lite/container/remote split was one component with a different `mcp_url`); self-hosting Matrix is demoted to a *"No Beeper?"* bottom note. Folded the redundant *How the chats get in* into Connection modes (keeping only the MCP-token config), and moved the architecture diagram and source map out to `system-state.md` (now pointers). 177 → 131 lines.
- **Connection-modes clarification** — the modes table's *Best for* column no longer conflates bridge placement with use-case; it now describes only where beeperbox runs. A new note makes explicit that **personal assistant vs. always-on chatbot is set by where `multis` runs** (a machine you own → personal assistant with `/exec`/`/read`; a VPS → chatbot), independent of the connection mode — a GUI home server gives both at once.

## [0.16.0] - 2026-06-16

Milestone state of the `baresuite-migration-m3` branch: multis becomes the first baresuite customer (bare-agent + bareguard as the agent/governance core), Beeper is rewired to a pure beeperbox-MCP client across all three deploy shapes, and two `/security` passes harden the assistant. **489/489 green.** Awaiting the live LIVE‡ verification pass (PRD §10) before merge to `main`.

### Security — full `/security` audit (8 findings) + limited-admin model

A standalone security pass over the whole branch. Each fix is red→green-proven (a regression test that fails without the fix, passes with it); the agent-path PIN fix (#5) was POC-validated first. Findings recorded in `docs/01-product/baresuite-migration-prd.md` §8.

- **Owner/admin model clarified.** The **super-admin** is the owner set at setup. `/admin` designates *limited* admins — staff who get knowledge-base commands (`/mode`, `/index`, `/ask`) but **never** host shell (`/exec`, `/read`) or `/admin`/`/pin` themselves. A single shared PIN gates the privileged surface.
- **#2/#3 — host tools are owner-only at the floor.** A `FORCE_OWNER_ONLY` floor in the tool registry plus `send_file` gated at the capability layer close the host-access surface; `~/.multis` is locked to `0700` and `config.json` to `0600` (it holds the PIN hash and tokens — previously world-readable).
- **#4 — parser input is bounded.** PDF/DOCX ingest now honours size / page / timeout knobs, so a hostile or pathological document can't hang or exhaust the indexer.
- **#8 — the agent loop is bounded.** `max_tool_rounds` carries a default cap, so a runaway tool-calling loop terminates cleanly via the gate.
- **#6 — owner RAG is scoped and fenced.** Owner queries retrieve only `admin`+`kb` scopes, and retrieved document content is fenced as untrusted (it can't smuggle instructions into the prompt).
- **#1 — per-customer rate limit on business-mode inbound.** An abusive customer chat **degrades to escalation** (notify the owner) rather than refusing service — bounded without going dark.
- **#5 — PIN enforced at the capability layer on the agent path.** Privileged tools invoked by the LLM now prompt for the PIN through the single `humanChannel`, closing the gap where the agent path skipped the auth the slash path enforced. POC-validated before build.
- **#7 — approvals route to the owner, not the requester.** A gate `ask` for a privileged action is sent to the owner's chat for approval, so a customer can never approve an action on their own behalf.
- **Path-traversal in the indexing sink** (attacker-named attachment filenames) was fixed earlier in the branch — see the beeperbox v0.7.0 entry below.

### Security — second `/security` pass (defense-in-depth)

An independent 3-agent audit of the branch code surface; every finding grounded at `file:line` before action, red→green where behavioral. Residuals, accepted-as-designed, and verified-clean items are catalogued in PRD §11.

- **Owner-only `admin` index scope.** A *limited admin* could `/index <file> admin` and plant content into the owner's trusted RAG/agent context; `admin` scope is now owner-only (limited admins manage the public KB only).
- **Owner identity tightened (Beeper).** `isOwner` now requires `isSelf` **and** `isPersonalChat` (the note-to-self channel), not bare `isSelf` — a self-message in a random/silent chat, or in a designated limited-admin chat, no longer confers owner. *Behavior change:* the owner dropping a file **into a business chat** now silent-indexes instead of prompting (the scope prompt no longer leaks into a customer-facing chat); note-to-self still prompts.
- **Exec env scrub.** The bot's own credentials (`ANTHROPIC`/`OPENAI`/`GEMINI`/`TELEGRAM`/`MCP_AUTH`) are stripped from the `/exec` child environment, so a command — including one driven by the LLM agent path — can't `echo $ANTHROPIC_API_KEY` and exfiltrate them.
- **Audit-log redaction.** Known secret values are replaced with `***` in the audit log (an `/exec` command or stderr could otherwise persist an inline secret in plaintext). The secret-key list is single-sourced in `config.js` so the scrub and redaction can't drift.
- **Attachment size ceiling.** `download_asset` caps the base64 decode (~25 MB) and `indexBuffer` rejects an oversized buffer **before** writing it to disk — the size cap previously ran only after the attachment was buffered in memory and written out.
- **Rate-limiter eviction.** The per-sender map now sweeps fully-aged senders, so business mode (where any stranger can open a chat) can't grow it unbounded.
- **Smaller hardening.** `config.json.bak` is `chmod 0600` (parity with `config.json`); the parallel `buildRAGPrompt` builder now nonce-fences retrieved chunks like the memory builder.

### Added — `/admin` limited-admin designation

- **`/admin`** (owner-only) designates, lists, and revokes limited-admin chats: `/admin` (pick a chat to promote), `/admin list`, `/admin remove <n>`. Limited admins get `/mode`, `/index`, `/ask`; host shell and admin management stay owner-only. Revocation takes effect immediately. `/help` is role-aware — owner, limited admin, and customer each see their own command block.

### Changed
- **CI:** the publish workflow now polls the npm registry for ~2 min (was ~15s; `--prefer-online` skips npm's view cache) and accepts an `exit 0` publish even if the registry hasn't reflected it yet, so a successful-but-slow-to-reflect publish no longer reports a false failure.
- **`publish.yml` is now manual-only (`workflow_dispatch`) — npm OIDC trusted publishing with provenance, idempotent, and verifies the registry end-state.**

### Baresuite migration — M-B step 3, Beeper attachments consumption (beeperbox v0.7.0)

**Beeper-sourced document indexing is un-paused** — the gap noted in Phase 2 ("owner sends a PDF → KB") is closed by consuming beeperbox **v0.7.0**'s attachment verbs (no shim — the lib grew the capability, multis consumes its public API).

- **`attachments[]` → `_attachments`.** `BeeperPlatform._handleMessage` now maps beeperbox's normalized `attachments[]` (`{type,file_name,mime_type,src_url,size,is_voice_note}`) onto the message's `_attachments` (`{fileName,srcURL,mimeType,size,isVoiceNote}`) that the `handlers.js` indexing pipeline already consumed. The dormant owner-`/index`, scope-prompt, and silent-capture paths re-light.
- **`downloadAsset()` → the `download_asset` MCP verb.** Replaces the raw `:23373` `/v1/assets/download` call; returns the attachment **bytes as a Buffer** (base64 over the MCP line). This is what makes attachment indexing work against a **remote `:23375`-only beeperbox**, not just a local one. The three `handlers.js` call sites drop the old path→`readFileSync` hop.
- **Verified live against the v0.7.0 container:** a real 706112-byte PDF round-trips byte-exact (valid `%PDF-` header) via both `download_asset` reference paths *and* through `BeeperPlatform.downloadAsset`. **442/442 green** (+4 adapter tests: attachment mapping, no-attachments case, verb call + args, no-data throw — mutation-proven).
- **Raw-`:23373` plumbing removed — Beeper is now a pure MCP client end-to-end.** With `downloadAsset` on the verb, the adapter's last raw-Desktop-API code is gone: deleted `_api`, `baseUrl`/`DEFAULT_URL`, `this.token`, and `_loadToken` (plus the `PATHS.beeperToken` path and the `_loadToken` tests). multis no longer reads a Beeper token at all — only the beeperbox MCP URL/token. The config template's stale `platforms.beeper.url` (`:23373`) is replaced with `mcp_url` (`:23375`). Verified live: `start()` + `download_asset` work with **no** Beeper token configured.
- **🔒 Security — path-traversal hardening in the indexing sink (`indexer/index.js`).** Attachment filenames are attacker-controlled (a chat sender names the file), and `indexBuffer` joined the raw name into a temp path — so a name like `../../../…` could escape and overwrite/delete arbitrary files (newly reachable via Beeper business-mode/silent indexing; also closed the pre-existing Telegram-silent path). Now `path.basename`-confined with degenerate names (`''`/`.`/`..`) rejected. Regression test is failability-proven (without the fix it deletes a sentinel outside the temp dir). Found by a `/security` pass on this diff.
- **Full ingest pipeline validated live (v0.8.0 container):** a real Beeper PDF → `download_asset` verb → real `pdfjs` parse → 4 FTS chunks at `scope=admin` → searchable on 6 terms, with a negative control (`zzqq…` → 0 hits) so the check can fail. End-to-end, no mock in the critical path.

### Baresuite migration — M-B step 3, Phase 3 (backend validation, MCP chat discovery, onboarding reframe)

- **3a — startup validation/logging:** `BeeperPlatform.start()` distinguishes an auth failure (401/403 → check `mcp_token`) from an unreachable endpoint, warns (without aborting) when beeperbox is reachable but reports 0 accounts, and logs the connected networks.
- **3b — chat discovery off raw `:23373`:** new `BeeperPlatform.listInbox()` over the `list_inbox` MCP verb; `findBeeperChat()` and `/mode`'s chat listing now use it, so a remote `:23375`-only beeperbox works end-to-end. (`downloadAsset` still uses raw `:23373` until beeperbox ships an attachments verb.)
- **3e — onboarding reframe (guide + wizard):**
  - **Wizard (`setup-beeper.js`) retired the OAuth-PKCE-against-`:23373` flow.** multis no longer logs itself into Beeper Desktop — the Beeper token lives in beeperbox. The wizard now prompts for the beeperbox MCP URL (+ optional token), verifies via `listAccounts`, lists accounts, and detects the Telegram bot chat via `list_inbox`. `multis doctor` / post-start / status now probe the MCP endpoint instead of `:23373/v1/spec`.
  - **Customer guide** reframed to the three deploy shapes (full container / lite / remote) with a topology diagram and an honest limitations matrix; the old "Beeper can't run on a VPS" guidance is reversed (the container runs headless).
- **Tests:** +`listInbox`, +`start` zero-accounts/auth-failure cases. 438/438 green; echo-guard and drain-cap mechanism tests mutation-proven; both the adapter and the wizard helpers live-smoked against a running container.

### Baresuite migration — M-B step 3, Phase 2 (rewire beeper.js onto beeperbox MCP)

**`src/platforms/beeper.js` now consumes beeperbox's MCP verbs** instead of walking the raw `/v1/chats` API — multis is a pure MCP client for watch/send (only `downloadAsset` still touches raw `:23373`, pending an attachments verb). **Bare Beeper Desktop is still supported**, not dropped: beeperbox's `mcp/server.js` is zero-dep vanilla Node and takes `BEEPER_API`, so it runs standalone against an existing local Desktop ("lite mode") and presents the same verbs as the full container. multis talks MCP to whichever shape is deployed — container, local-lite, or remote.

- **Watch → `poll_messages` cursor.** One cursor-advancing poll per tick, drained across `has_more` pages (capped at 10/tick). The cursor persists to `~/.multis/run/beeper-cursor.json` and resumes across restart — no missed or duplicated messages. **Removed:** `_seedLastSeen`, the `/v1/chats?limit=20` walk, the `_seen`/`_processing` dedup sets, and the 30s-gap re-seed (the cursor makes all of it redundant). Also fixes the old recent-25-chats blindness — `poll_messages` is a global feed.
- **Echo-guard → `source:"api"`.** The adapter skips messages beeperbox tagged as its own sends (exact-id matched upstream). **Removed:** the `[multis]` text prefix, `_isLooping`, and `selfIds`/`_isSelf` (routing now reads `sender.is_self` straight off the message).
- **Send → `send_message` with a unique `client_tag`** (no more `[multis]` prefix).
- **Chat metadata** (`title`, `is_note_to_self`) resolved via `get_chat`, cached per chat on first sighting.
- **Policy unchanged** — modes (`off`/`silent`/`business`), personal-chat command gating, natural-language routing, owner model, `_personalChats`/`getAdminChatIds`.
- **Tests:** `test/beeper.test.js` rebuilt on an injected MCP-client seam (cursor seed/resume, `has_more` drain + cap, `source:"api"` skip, bot-chat exclusion, `get_chat` caching, all routing modes). **434/434 green**; the echo-guard and drain-cap mechanism tests are mutation-proven.
- **Known gap — attachments paused.** `poll_messages` doesn't carry attachments yet, so Beeper-sourced document indexing (owner sends a PDF → KB) is paused pending a beeperbox verb (PRD §7, 2026-06-16). No shim in multis (customer contract); the `downloadAsset` seam relights the moment beeperbox surfaces `attachments[]`.

### Baresuite migration — M-B step 3, Phase 1 (beeperbox MCP client)

**Added `src/platforms/beeperbox-mcp.js`** — a vanilla JSON-RPC 2.0 client for beeperbox's MCP HTTP transport (**no new dependency** — global `fetch`; the transport is a plain stateless POST). Exposes the verbs multis composes (`poll_messages`, `send_message`, `note_to_self`, `list_accounts`) with explicit failure paths: HTTP status, JSON-RPC error+code, network failure, timeout (AbortController), non-JSON body, and MCP `isError`. **17 unit tests** (injected-fetch DI seam; the abort-mechanism and `isError` tests are mutation-proven) + a live smoke against the container. **Phase 2** — rewiring `src/platforms/beeper.js` onto this client (dropping the `[multis]` prefix, `_isLooping`, and the hand-rolled seed/dedup/wake-reseed machinery) — is next.

Foundation validated end-to-end against a live container (the basis for Phase 2):

- **`poll_messages`** (beeperbox PR #11) — cursor-based passive watch; proven **exactly-once within a single cursor chain** (4 sequential sends, 0 dup / 0 loss) — the property the old NaN-dedup / wake-flood bugs broke.
- **Exact-id echo-guard** (beeperbox PR #13) — `source:"api"` now resolves `pendingMessageID` → final bridge id and matches by **exact id, not text**. Verified with the discriminating test: two identical-text sends each tagged with their own `client_tag`, no crossing — closes beeperbox's CI-unverifiable limit. Lets multis drop both the `[multis]` prefix **and** `_isLooping`.
- **Container stability** (beeperbox PR #12/#13) — `docker restart` no longer segfaults (stale Xvfb-lock fix); `beepertexts` is supervised (real crash → relaunch in ~10s, verified).
- Upstream asks filed → resolved → verified in `docs/01-product/baresuite-migration-prd.md` §7.

## [0.15.0] - 2026-06-15

### Baresuite migration — M0–M2 + F2/F3 (multis is the first baresuite customer)

multis now consumes the current baresuite (bareguard 0.7.0, bare-agent 0.16.1) and closes the two upstream findings the validation net surfaced. Governing doc: `docs/01-product/baresuite-migration-prd.md`.

#### M0 — validation net

- **New `test/e2e/router.test.js`** — drives the **real** message router with a mock LLM and a **real fileless bareguard Gate** (genuine policy, action translator, owner-bypass, audit). Covers QA smoke steps 5–11 via BOTH the LLM tool-call path and the slash-command path, proving "governance = bareguard" holds uniformly.
- **F1 fix — slash `/exec` `/read` bypassed the gate.** `routeExec`/`routeRead` now run the same `gov.resolve().policy` as the LLM tool path before executing (`enforceGate` helper). Previously they called `execCommand`/`readFile` directly, so governance only applied on the LLM path. (PRD §8.)
- `test/helpers/setup.js` gains `realGov()` (builds the real fileless Gate) and `mockToolProvider`.

#### M1 — bareguard 0.4.2 → 0.7.0

- **Dependency:** `bareguard ^0.4.2 → ^0.7.0`. Additive for multis — full suite green on the bump with no `buildGateConfig` changes required for the bump itself.
- **F2 RESOLVED upstream — no new primitive needed.** The "always ask before every exec" requirement is met by bareguard's `flags` primitive (shipped 0.6.0): `flags:{ type:{ bash:'ask' } }` fires an ask at eval **step 4b — before the allowlist (step 5)** — so an allowlisted command still asks, routed through the single `humanChannel` with `_ctx` intact. The original repro failed only because it ran on 0.4.2, which predates `flags` (the config key was silently ignored). Validated directly against the published `Gate` with negative controls (no-flags → no ask; flags-on-other-type → no ask). Consumed in the F2 cutover below.

#### M2 — bare-agent 0.10.2 → 0.16.1

- **Dependency:** `bare-agent ^0.10.2 → ^0.16.1`. Pinned to **0.16.1** specifically — the release that ships the F3 fix (0.16.0 still had the bug).
- **F3 RESOLVED — LLM cost accounting on the agent loop is live again.** Pre-fix, `CircuitBreaker.wrapProvider` returned a bare `{generate}`, dropping `.model`; `Loop` read `this.provider.model` → null → `estimateCost` → null, so `budget.maxCostUsd` accrued **zero** token cost on every wrapped-provider loop (i.e. the cost cap was silently dead in production). bare-agent 0.16.1 fixes it three ways: `wrapProvider` preserves passthrough props (`...provider`), `Loop` falls back to `result.model`, and the providers emit `model` in their result. Verified against the installed artifact, not a working tree.
- **Real cost-accrual e2e** — the M0 budget-halt test no longer injects spend directly (the workaround for dead F3). It now drives a genuine halt: a first LLM turn reports `claude-haiku-4-5` + token usage → `Loop` derives ~$0.0048 → accrues via `onLlmResult` → trips `max_cost_per_run` ($0.0001) → halts at the exec gate → `humanChannel` with `_ctx.chatId`. Asserts a non-null `costUsd` lands in the audit. Failability-proven (drop the reported model → the test fails).

#### F2 cutover — one approval path

- **Removed the bare-agent `Checkpoint` bridge.** Deleted `src/bot/checkpoint.js`, the `Checkpoint` wiring in `runAgentLoop`, and the separate checkpoint reply interception. Confirm-before-every-exec now flows through bareguard's `flags` primitive and the single `humanChannel` — governance = bareguard, no parallel local approval path.
- **`buildGateConfig` maps `security.checkpoint_tools` → `flags:{ type:{ <gateType>:'ask' } }`** (tool names mapped to gate types: `exec→bash`, `read_file/send_file/grep_files/find_files→read`). Default `['exec']` preserves confirm-before-every-exec; an explicit `[]` opts out.
- **`content.askPatterns` now composes** `[...SAFE_DEFAULT_ASK_PATTERNS, ...injection]` instead of replacing the safe defaults (bareguard treats a set `askPatterns` as a full override, so the defaults were previously dropped).
- **Behavior change:** confirm-before-exec was previously LLM-tool-path only (the checkpoint lived in `runAgentLoop`); it now fires at the shared gate, so **slash `/exec` also asks**. Uniform by design.
- Always-ask covered at three levels: the `flags` primitive in isolation (throwaway POC vs the published Gate, with negative controls), multis wiring (unit + e2e tests asserting `rule: flags.type`, allowlisted-still-asks, `_ctx` preserved, opt-out), and failability (mutation: break the mapping → tests fail). Obsolete checkpoint unit tests removed.

#### M-B (step 2) — beeperbox parity + swap-by-config

multis can now point at a [beeperbox](https://github.com/hamr0/beeperbox) container (headless Beeper on a VPS) by **config alone** — validated end-to-end against a live container with multis's real client. Governed by PRD §E (verbs in beeperbox, policy in the integrator).

- **Token from config (swap-by-config enabler).** `_loadToken()` resolves `platforms.beeper.token` → `BEEPER_TOKEN` env (the same var beeperbox uses) → token file → legacy. Pointing at beeperbox is now `{ url, token }` in config, zero code wiring.
- **Canonical note-to-self detection.** New `_isNoteToSelf()` uses `participants.total === 1 && items[0].isSelf` (beeperbox's rule) — stricter and pagination-proof vs the old `items.every(p=>p.isSelf)` (which would misflag a big group whose loaded participant page happens to show only you). Parity, not a live bugfix — current data showed no divergence; the new test includes a pagination trap that the old rule fails.
- **Documented the `/v1/chats` recent-25 polling bound** (the API caps at 25, recency-ordered; use `/v1/messages/search` for full reach).
- README: documents beeperbox as the self-host-on-VPS deploy path.
- Tests: +2 token-resolution cases (config precedence, env fallback, env-isolated); note-to-self test reshaped with the real `{items,total}` shape + pagination trap. Suite 415 → 417, green.

## [0.14.0] - 2026-05-12

### Changed — Governance seam closed (bareguard 0.4.2 + bare-agent 0.10.2)

The remaining adopter friction from v0.13.0 closed in two upstream patches. multis now meets bareguard at the natural API — no field-hoisting transforms, no doubled round counts.

- **`limits.maxToolRounds` replaces the `maxTurns: rounds * 2` arithmetic.** bareguard 0.4.2 added a sibling primitive that ticks only on non-`llm` records, so `config.llm.max_tool_rounds` maps 1:1. The `*2` multiplier and the regression test that pinned it are gone.
- **Verbatim args form replaces the `bash.cmd` / `fs.path` hoist.** bareguard 0.4.1's `bashCheck` and `fsCheck` already read `args.command` / `args.path` via fallback; with the upstream pin in place we can drop the field hoist. The translator now only maps tool names → bareguard types (`exec → bash`, `read_file/send_file/grep_files/find_files → read`).
- **`gate.js` translator simplified** — symlink resolution now mutates `args.path` directly. Action shape is `{ type, args, _ctx }` end-to-end. File header docstring rewritten.

### Fixed (carries v0.13.x bug fixes)

- `send_file` is now translated to `{type:'read'}` so `fs.deny` gates outbound files (was bypassing the path allowlist).
- Owner-bypass writes a `phase:'denied-owner'` audit entry via `gate.record` before returning the deny string — non-owner attempts no longer disappear from `gate.jsonl`.
- Carrier `resolve()` self-heals: `resolving.catch(() => { resolving = null; })` so a transient ESM-import failure doesn't permanently brick the bot.
- `src/index.js` shutdown handler now calls `PATHS.pid()` (was an undefined `pidPath`, raised `ReferenceError` and leaked the PID file).
- `/status` and the startup banner read the version from `package.json` (was hardcoded `v0.1.0` since the first POC).

### Dependencies

- `bare-agent` `^0.10.1` → `^0.10.2` (README leads with `limits.maxToolRounds`; `actionTranslator` example uses verbatim args form; two new real-bareguard smoke tests cover both).
- `bareguard` `~0.4.1` → `^0.4.2` (added `limits.maxToolRounds`; carry-over from 0.4.1: `bashCheck` / `fsCheck` accept `args.command` / `args.path` via fallback).

### Tests

- 404/404 passing. Translator tests rewritten for the verbatim args shape; `limits.maxToolRounds` tests assert the 1:1 mapping.

### Docs

- New `docs/04-process/qa-smoke.md` — 15-step manual smoke checklist with explicit regression markers for each bug fixed in the v0.13.x cycle (notably step 9 = owner-bypass audit, step 15 = pidPath shutdown).

---

## [0.13.0] - 2026-05-12

### Changed — Governance migrated to bareguard 0.4 + bare-agent 0.10

The Loop-level policy closure introduced in v0.12.0 is replaced by a real **bareguard Gate**. bareguard owns command/path allowlists, budget caps, audit JSONL, secrets redaction, and the single `humanChannel` callback for all human escalations. bareagent's `Loop` only knows about the `policy` predicate it gets from `wireGate(gate)`. multis is bareguard's first production adopter.

- **New `src/governance/gate.js`** — `createGate({config, humanPrompt, ...})` factory. Lazily `await import('bareguard')` (multis is CJS, bareguard is ESM); maps `governance.json` → `bash.allow`/`bash.denyPatterns` + `fs.readScope`/`fs.deny`; configures `secrets.envVars` + `content.askPatterns` (absorbed multis' prompt-injection patterns); routes `security.max_cost_per_run` → `budget.maxCostUsd` and `llm.max_tool_rounds` → `limits.maxTurns` (doubled — bareguard counts both LLM and tool records).
- **New `src/governance/human-channel.js`** — single `humanPrompt` closure handles both ask and halt events. Routes back to the originating chat via `event.action._ctx.{platform, chatId, senderId}` (bareguard 0.4's halt-event contract). Reuses the pending-reply Map pattern from `src/bot/checkpoint.js`.
- **Deleted `createMultisPolicy()`** from `handlers.js`. Replaced by a lazy `createGovernanceCarrier(config)` that resolves `{policy, onLlmResult, onToolResult, filterTools}` from `wireGate(gate)` on first agent loop call.
- **Action shape translation** — `translateAction()` hoists `exec → {type:'bash', cmd}`, `read_file/grep_files/find_files → {type:'read', path}` so bareguard's bash/fs primitives see the canonical fields they expect (they read `action.cmd` and `action.path` at top level, not under `args`).
- **LLM cost recording now wired** — `Loop({onLlmResult})` forwards every `provider.generate` usage to `gate.record({type:'llm'})`. Pre-BA1, `budget.maxCostUsd` only saw tool cost and was effectively a lie for token-heavy / tool-light chatbot workloads.
- **Halts no longer leak to the LLM** — bareagent throws `HaltError` from the policy on halt-severity decisions; Loop catches it and exits with `result.error = 'halt:<rule>'`. The `[HALT:]` string never reaches the model.
- **Audit split** — bareguard writes gate decisions to `~/.multis/logs/gate.jsonl` (forensic, structured by phase). multis' existing `src/governance/audit.js` keeps the 50+ app-event call sites at `~/.multis/logs/audit.log`.
- **Shared budget across chats** — every chat shares one budget cap via `~/.multis/run/budget.json` (`proper-lockfile`).
- **`Checkpoint` retained** for non-policy "always confirm" flows (e.g. `send_email`-style). Per bareagent context, Checkpoint and humanChannel coexist for distinct use cases.
- **Dropped from Loop config:** `maxCost`, `maxRounds`, `audit` (all gone in bare-agent 0.10 — moved to the Gate).
- **Tool name vocabulary preserved** — multis keeps `exec`/`read_file`/`grep_files`/`find_files` as LLM-facing names. Translation happens inside the policy shim, not at the tool definition layer.

### Dependencies

- `bare-agent` `^0.7.0` → `^0.10.1` (10.1 re-exports `HaltError` from main, adds `defaultActionTranslator`, throws on legacy `maxRounds`)
- `bareguard` `^0.4.1` added (4.1 ships the action-shape composition fix and documents the maxTurns ratio)

### Tests

- 403/403 passing. `test/governance.test.js` fully rewritten against the new shape: governance.json → Gate config mapping, action translation, owner gate, end-to-end with fileless audit (`audit.path: null` from bareguard 0.4), halt routing via `event.action._ctx`.

### Adopter feedback round-trip

Three of the four items I filed during the v0.13.0 integration shipped in patch releases by the time the docs landed:

- ✅ **`HaltError` now in `require('bare-agent')`** (bareagent 0.10.1). Dropped the `require.resolve('bare-agent')` + walk-to-`src/errors.js` workaround — back to a clean `const { HaltError } = require('bare-agent')`.
- ✅ **`wireGate(gate, { actionTranslator })`** + exported `defaultActionTranslator` (bareagent 0.10.1). Replaces multis' custom policy shim. The translator hoists `exec → bash.cmd` and `read_file → fs.path` at the seam instead of bypassing wireGate. multis still keeps owner-bypass + symlink resolution on its side (multis-specific behavior, not adapter concerns).
- ✅ **`Loop({ maxRounds })` now throws** with a migration pointer to `limits.maxTurns` (bareagent 0.10.1). Catches anyone migrating from 0.9.
- ✅ **maxTurns semantics documented** in bareguard 0.4.1 README. `maxTurns: rounds * 2` is the recommended pattern.

---

## [0.12.0] - 2026-04-16

### Changed — Governance consolidation (bare-agent v0.7.0)

Multis had two parallel governance systems (command/path allowlist in `validate.js` called from `executor.js`, plus a separate checkpoint tool list). Both are now replaced by **one policy closure** wired into bareagent's Loop at construction time — one hook gates every tool call with per-caller `ctx` routing.

- **Deleted** `src/governance/validate.js` — replaced by `bare-agent/policy` helpers (`pathAllowlist`, `commandAllowlist`, `combinePolicies`). Same `governance.json` config file, same rules, zero duplication.
- **Stripped governance from `executor.js`** — `isCommandAllowed` / `isPathAllowed` / `requireConfirmation` removed. Shell-out logic stays (25+ tools still call `execCommand`). Governance is Loop-level now.
- **New `createMultisPolicy()`** in `handlers.js` — reads `governance.json`, builds a combined policy closure, wired into `Loop({ policy })` with `ctx: { senderId, chatId, isOwner }` forwarded per-run.
- **Dropped dead code:** `requireConfirmation` (printed a message but had no path to confirm), `governance.enabled` flag (always-on, never gated), unused config fields (`rateLimits`, `business.allowed_urls/topics/rules`, `documents.maxSize/allowedTypes`, `governance.auditLog`).
- **Symlink traversal fix** — policy closure resolves `realpathSync` before path allowlist check.
- **`maxCost`** wired from `config.security.max_cost_per_run` (optional runaway cap).
- **`onError`** callback writes Loop errors to audit log with chatId context.

### Changed — Checkpoint simplification

- Removed custom timeout timer from `checkpoint.js`. Uses bareagent's built-in `Checkpoint({ timeout })` — on expiry, auto-denies and routes through `loop:error` + `onError`. No silent hangs.

### Security

- **PIN:** `verifyPin` now uses `crypto.timingSafeEqual` (constant-time comparison).
- **PIN:** Session file mode `0o600`, directory mode `0o700` (owner-only).

### Dependencies

- `bare-agent` `^0.3.0` → `^0.7.0`

### Tests

- 395/395 passing (zero regressions). Governance tests rewritten to use `bare-agent/policy` helpers.

---

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
