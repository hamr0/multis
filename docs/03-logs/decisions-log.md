# Decisions Log

## D1: Node.js over Python
**Date:** 2026-02-09
**Decision:** Node.js with vanilla standard library, minimal deps.
**Rationale:** Aurora is Python — multis is a port/reimagining, not a copy. Node.js is simpler for daemon + bot + CLI in one codebase. Telegraf is the best Telegram bot library.

## D2: Telegram as mandatory control channel
**Date:** 2026-02-09
**Decision:** Telegram Bot API (via Telegraf) is always available, zero infra required.
**Rationale:** Every user has Telegram. No server needed. Direct Bot API is stable and free.

## D3: Beeper Matrix API — rejected
**Date:** 2026-02-09
**Decision:** Do not use Beeper's Matrix API for bot integration.
**Rationale:** iOS hijacks cross-signing keys, bridges refuse encryption keys to bot device. WhatsApp on-device bridge sends zero messages to Matrix. Node.js Rust SDK lacks key import. Detailed investigation: `.claude/stash/2026-02-09-beeper-e2ee-verification.md`.

## D4: Beeper Desktop API — accepted as Path 2
**Date:** 2026-02-09
**Decision:** Use Beeper Desktop localhost API (port 23373) for multi-platform.
**Rationale:** Bypasses E2EE entirely. Talks directly to Desktop app. Requires Desktop running but gives access to all bridges. Token-based auth.

## D5: Self-hosted Matrix as Path 3 (fallback)
**Date:** 2026-02-09
**Decision:** Per-user VPS with Synapse + mautrix bridges as the fully self-hosted option.
**Rationale:** User owns all data, no E2EE issues (you're server admin), but requires VPS ($5-10/month) and domain.

## D6: Three-path platform strategy
**Date:** 2026-02-09
**Decision:** One config file, three paths: Telegram (mandatory), Beeper Desktop (optional), Matrix self-hosted (optional).
**Rationale:** Users fill in what they have. Telegram is always available. Beeper for convenience. Matrix for full control.

## D7: SQLite FTS5 for search (not BM25 module)
**Date:** 2026-02-09
**Decision:** Use SQLite FTS5 built-in BM25 ranking instead of a separate BM25 implementation.
**Rationale:** FTS5 handles tokenization, ranking, and matching. No need for aurora's Python BM25 scorer. Simpler, faster, built into better-sqlite3.

## D8: Chat modes for Beeper (personal vs business)
**Date:** 2026-02-10
**Decision:** Per-chat mode system for Beeper: personal (default, ignore incoming) vs business (auto-respond).
**Rationale:** Beeper sees all your chats. Without modes, bot would either respond to everything (noisy) or nothing (useless). Modes give user control per-chat.

## D9: Plain text = implicit ask
**Date:** 2026-02-10
**Decision:** Non-command text in Telegram or Beeper personal chats routes to `routeAsk` (LLM + RAG).
**Rationale:** Replaces echo handler from POC1. The bot should be useful by default — ask questions, get answers. Explicit `/ask` command still available.
