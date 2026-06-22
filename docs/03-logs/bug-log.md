# Bug Log

## B1: Telegraf `bot.on('text')` fires for commands too
**Date:** 2026-02-09
**Severity:** Medium
**Fix:** Filter with `text.startsWith('/')` in the text handler.
**Lesson:** Telegraf's `bot.on('text')` catches ALL messages including `/command` messages. Must explicitly check.

## B2: Telegraf `bot.start()` uses `ctx.startPayload` not `ctx.message.text`
**Date:** 2026-02-09
**Severity:** Low
**Fix:** Use `ctx.startPayload` for deep link parameter extraction.
**Lesson:** `ctx.message.text` contains `/start <code>` but `ctx.startPayload` directly gives the code part.

## B3: Beeper E2EE blocks bot messages
**Date:** 2026-02-09
**Severity:** Blocker
**Fix:** Switched to Beeper Desktop localhost API (bypasses E2EE).
**Lesson:** Don't fight the platform's security model. Beeper owns cross-signing. Use their local API instead.

## B4: beeperbox `list_accounts` wedged to 0 while the Beeper API was healthy
**Date:** 2026-06-19 → 2026-06-20
**Severity:** Medium-Low (self-recovered; not a multis bug — beeperbox repo)
**Symptom:** After a noVNC add-WhatsApp session, beeperbox MCP `:23375` `list_accounts` returned `0`,
while the in-container Beeper Desktop API `:23373/v1/accounts` returned ALL accounts healthy. A plain
`docker restart beeperbox` did NOT clear it; it recovered by the next session (`list_accounts` → 5
incl. WhatsApp, re-verified live 2026-06-20). Recovery trigger not pinned.
**Not the cause:** not multis, not a wrong port (`:23375` is correct), not WhatsApp-disconnected, and
not the resolved Xvfb-lock segfault (the backend + `:23373` were healthy throughout — this was
MCP-layer account-list staleness, not a dead backend).
**Disposition:** beeperbox-repo fault (Principle 8) — filed as an upstream ask
(`docs/01-product/beeperbox-asks/account-sync-resilience.md`, PRD §7 2026-06-20), NOT patched from
multis. Did not block the M9 LIVE‡ gate (gate work needing no 2nd live identity proceeds per
Principle 4).
**Lesson:** when a verb layer disagrees with the API underneath it, probe both layers before blaming
the consumer; a silent `0` from a relay that a restart won't fix is an observability gap worth filing
even when it self-heals — the next recurrence should be diagnosable, not a mystery.
