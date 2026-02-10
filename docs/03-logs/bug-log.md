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
