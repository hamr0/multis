# beeperbox ask: account-list relay resilience + observability

> Upstream ask from **multis** (the driving consumer). Filed per the baresuite migration's lane rule:
> this is *observed behaviour + requirements*, not an implementation authored from multis.
> Tracked in `docs/01-product/baresuite-migration-prd.md` §7 (2026-06-20).
>
> **Severity: MEDIUM-LOW, non-blocking.** The symptom self-recovered before this could block the M9
> LIVE‡ gate. Filed so it isn't lost and so a recurrence is diagnosable — not as a stop-and-wait.

## What was observed (2026-06-19 → 2026-06-20)

During a noVNC session that added a WhatsApp account inside the headless container, beeperbox's
account relay **wedged**:

- **beeperbox MCP `:23375` `list_accounts` → `0`** (had returned 4 earlier the same session).
- **The underlying in-container Beeper Desktop API `:23373/v1/accounts` → returned ALL accounts,
  healthy** (`matrix`/Beeper "Amr Hassan" `status:connected`, `discordgo`, …). Token valid (len 36),
  `/v1/` paths correct (`/v0/` → 404).

**Decisive split:** the Beeper app and its API were fine and had every account; **beeperbox stopped
relaying the account list it could plainly see one layer down.** This is NOT the Xvfb-lock segfault
from the resolved lifecycle-robustness ask (that crashes the *backend* and `:23373` goes dark; here
`:23373` was healthy throughout). This is an MCP-layer **account-list staleness** distinct from a
dead backend.

- **A plain `docker restart beeperbox` did NOT clear it** (came back still `0` while `:23373` had the
  data).
- It **later recovered** (next session: `list_accounts` → 5, incl. the WhatsApp account). **The exact
  recovery trigger is not pinned** — a fuller `down`/`up`, a force-recreate, or elapsed time; multis
  did not capture which. We do not claim to know.

## Why it matters (product, not just the gate)

multis's business mode reaches real contacts **only** through beeperbox's bridges (Telegram bot is
not customer-facing). If `list_accounts` silently returns `0` while the bridges are actually up,
multis sees "no accounts," routes nothing, and **a product user cannot diagnose it** — the GUI shows
all chats, the API shows all accounts, only the MCP verb lies, and a restart (the obvious user move)
doesn't fix it.

## The ask (beeperbox owns mechanism — §E)

Two parts, in priority order:

1. **Observability (REQUIRED, the higher-value half).** Make the discrepancy *visible* so a recurrence
   is self-diagnosing instead of a silent `0`:
   - On `list_accounts`, when the MCP layer's cached/relayed account set diverges from what
     `:23373/v1/accounts` currently returns, **log it** (count expected vs relayed) rather than
     silently returning the stale set.
   - Surface backend account health in the **healthcheck** (the lifecycle ask already moved the
     healthcheck toward `:23373`) — a `:23373`-has-N-but-relay-has-0 state should be observable, ideally
     flip the container unhealthy or at least WARN, not read as healthy.

2. **Resilience (REQUIRED).** `list_accounts` should reflect the live backend, not a relay that can
   wedge stale:
   - Either re-read `:23373/v1/accounts` on demand (it's cheap and authoritative), or invalidate/refresh
     the relayed account set on account-change events (the noVNC add-account flow is exactly when it
     wedged).
   - At minimum, a **plain `docker restart` must recover it** — today it did not, which is the worst
     property (the obvious operator action is a no-op).

## Acceptance

- With the Beeper backend healthy and `:23373/v1/accounts` returning N accounts, `:23375`
  `list_accounts` returns the same N (no stale `0`/undercount).
- Adding/removing an account in the container (noVNC) is reflected by `list_accounts` without a
  full container teardown.
- If the relay *does* diverge from the backend, it is **logged/healthcheck-visible**, not silent.
- A `docker restart` recovers a wedged relay.

## What multis did NOT do

No multis-side patch, no re-read of `:23373` from multis to "work around" a `0` from `:23375`
(that would re-introduce the raw-`/v1/` coupling Phase-2 deliberately removed, and paper over a
beeperbox fault). multis stays a pure `:23375` MCP client; per Principle 4 it proceeds with gate work
that doesn't need a second live identity, and consumes this when beeperbox ships it.
