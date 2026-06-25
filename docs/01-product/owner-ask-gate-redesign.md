# M10 — Unified owner-ask gate (ceremony/pending/park-resume redesign)

**Status:** BUILT — **§1–§6 LOCKED 2026-06-24; implemented 2026-06-24, suite green (520/520), PENDING LIVE VERIFICATION.**
Keystone replay regression written red→green. One dispatcher (`src/bot/ask-dispatcher.js`) + `makeCeremonyAsk` (both doors) landed. routeAsk memory rewired (§5): the request enters `recent.json` only at completion, paired with its outcome; a parked ceremony records (request→outcome) at the PIN reply — no dangling, no replay; PIN digits never recorded. 6 of 7 ask types migrated onto the dispatcher (PIN ceremony, index + mode pickers, business menu + setup wizard, /pin change wizard); the 7-case router switch is down to 2 (ASK_KIND + gate_reply). **gate_reply is NOT migrated by design** (§6 step-4 assessment): it is a parked-promise *resolver* for bareguard HITL where the router hands raw yes/no/PIN to `entry.resolve()` — routing it through the dispatcher's cancel/stick logic would eat a "no" deny before it reaches the resolver; it is also still live for Telegram `checkpoint_tools` (opt-in), so not deletable. **Still owed:** live serial-transport (Beeper) verification — the project rule is that only live testing confirms a poll-loop fix.
**Motivation:** live testing (2026-06-24) surfaced the "stuck on delete" bug — a parked destructive request replays on every later turn. Investigation showed the owner-interaction lifecycle is **4 parallel park-and-resume implementations** with no shared contract; the bug lives in the seam between them. Owner called for a redesign, not a fifth patch.

---

## 1. The problem (why a redesign, not a patch)

"The bot needs something from the owner and must pause until they reply" is implemented **four times** with no unified contract:

1. **Slash door** — `handleCeremonyOrSend` (handlers.js): prompt → `pending.set('ceremony_action')` → resume via `dispatchCapability(…, ceremonyReply)`.
2. **LLM door** — `wrapToolThroughCore` (handlers.js): prompt → `pending.set('ceremony_action')` → set `_ceremonyParked` flag → `HaltError` from the `onToolResult` seam → resume via `runGovernedAction(…, ceremonyReply)` directly.
3. **Router dispatch** — a 7-case switch (handlers.js ~386–537) over `PendingRegistry` entry types, each with its own match/TTL/resume semantics.
4. **Memory** — `routeAsk` appends the user message *before* the loop, the assistant message *after* — but a parked ceremony halts the loop and `routeAsk` returns early, so **no resolution is ever recorded**, and the `ceremony_action` handler has no access to the memory manager so the PIN reply isn't recorded either.

**Root bug:** the request is written to `recent.json` with no recorded ending, so the model replays the dangling destructive request every subsequent turn. The fix is not "append the PIN reply" in one more place — it's a single coherent lifecycle that **records every ask's outcome**, by construction, for all 7 types.

---

## 2. The organizing principle — control-flow vs conversation (LOCKED)

There are two distinct meanings of "the bot is waiting for a reply." The bug is that they got mixed.

| | **Operator control-flow** (the 7 ask types) | **Conversation** (customer/contact/owner chat) |
|---|---|---|
| Who | **owner only** (today) | anyone (customer, contact, owner) |
| Next message is | *the answer* — gated, not re-routed | *a normal turn* — routed freely |
| "What time is it?" mid-ask | → "⏳ still waiting" | → answered normally |
| Lives in | `PendingRegistry` (control state) | `recent.json` (conversation) |
| Fed to the LLM | **never the raw mechanics** | **always** |

**Customers/contacts are NOT in this machine.** All 7 ask types are owner-only operator actions; a customer is never a privileged principal and never triggers a PIN/picker/wizard. A customer's back-and-forth is plain conversation (LLM + `recent.json`), with no deterministic gating. The unified contract must stay **principal-aware** (an ask is bound to `(chatId, senderId)`; owner-asks require owner) so a future *non-privileged* structured flow (e.g. a customer booking picker) could exist — but we build no such thing now (YAGNI).

**It is one conversation, not two boxes.** The fix is not hiding asks in a separate store — it is **recording each ask's ending**. The conversation records the *meaning* of the exchange ("asked to delete X → ✓ done" / "cancelled"); only the **transient mechanics** stay out — the literal PIN keystrokes (`1258`, a secret) and the prompt-noise ("🔒 enter your PIN", "⏳ still waiting"). If you scroll back through the chat, you see request → outcome, never the keystrokes.

**Completion is a recorded state transition, not a guess.** Each ask has one explicit state — `pending → resolved | cancelled` — owned in one place. The resume already produces the signal (success / cancelled / locked-out = terminal; wrong-PIN = stay pending); the machine must *act on it*: on terminal, write the outcome to conversation and clear; on retry, stay pending. Today that signal is thrown away — which is the entire bug.

---

## 3. The one contract every owner-ask implements (LOCKED)

Replace the 7-case switch + 4 park/resume copies with **one dispatcher** driving objects of one shape. Each ask provides only:

- **`prompt`** — text already shown ("🔒 enter your PIN", "Pick 1/2/3"). Transient; **never recorded**.
- **`accepts(text)`** — is this a valid answer? (PIN → `^\d{4,6}$`; picker → `1..N`; wizard step → its check.)
- **`handle(text)`** → returns exactly one outcome:
  - **`{ done, summary }`** — valid answer, action ran. `summary` = the one clean conversation line ("✓ deleted X", "Amora set to off"). Ask clears.
  - **`{ retry, reprompt }`** — wrong/invalid (wrong PIN). Stays pending; sends `reprompt` ("Wrong PIN, 2 left").
  - **`{ next }`** — multi-step; advance to the next step (wizard / pin-change). Stays pending.

The **one dispatcher** owns everything currently copy-pasted or missing:
- **cancel** ("cancel/stop/abort/no") → clear + record "cancelled" — once, for every type.
- **stick** — anything that isn't an answer or cancel → uniform "⏳ still waiting"; the ask stays put (the owner invariant). One ask at a time per `(chatId, senderId)`.
- **record** — on `{ done }`/cancel, write `summary` into conversation (`recent.json`). Doing this in the dispatcher fixes the replay bug for **all 7 types at once**.

Each of the 7 types fills in only `prompt / accepts / handle`; none touch memory or routing. There is exactly one place that knows how an ask starts, sticks, resolves, and is recorded.

---

## 4. Both doors construct one ask; one resume path (LOCKED)

Today each door parks its **own** resume closure, and they differ: slash re-runs `dispatchCapability(…, ceremonyReply)`, LLM calls `runGovernedAction(…, ceremonyReply)` directly. Same destination, two paths.

**One factory builds the ask, both doors use it.** `makeCeremonyAsk({ capability, args, ctx })` returns an ask whose:
- `prompt` = verbatim *"🔒 needs your PIN — `<echo>`"* (built once),
- `accepts(text)` = `^\d{4,6}$`,
- `handle(text)` = `runGovernedAction({ capability, args, ctx, ceremonyReply: text })`, mapped: OK → `{ done, summary }`; wrong-PIN-tries-left → `{ retry, reprompt: "Wrong PIN, N left" }`; lockout → `{ done, summary: "didn't run — locked out" }` (terminal).

Defined **once** — "run this capability with this PIN" is identical whether it came from `/exec` or the model calling `exec`. Both doors then do two steps: build the ask, `dispatcher.open(ask)`. Slash returns (poll loop free); the LLM door opens it **mid-loop → the loop yields**. `handleCeremonyOrSend` and the bespoke `wrapToolThroughCore` ceremony branch both collapse into "build ask, open it"; the divergent closures and `dispatchCapability`-vs-direct-core split are gone.

**Loop-yield mechanism:** stays the **HaltError-from-the-`onToolResult`-seam** (the only thing bare-agent honors today), reframed as a general rule — *opening an owner-ask during a turn ends the turn; the model can't proceed until the owner answers.* Simplifies to a direct `throw` from `execute` once the §7 bare-agent ask lands.

## 5. Memory wiring: record the exchange at completion, never eagerly (LOCKED)

The bug: `routeAsk` appends the user request **before** the loop (handlers.js:1365), the loop parks + halts, the outcome is never appended → the request dangles and replays; the `ceremony_action` handler has no memory access to fix it.

**Two rules:**
1. **A turn enters conversation only when it *completes*, as a paired (request → outcome) exchange.** Stop appending the user message eagerly. The live request is handed to the loop as a message (history still comes from past *completed* turns) and is written to `recent.json` only at completion, with its outcome. While an ask is pending, `recent.json` holds **nothing** about this turn — pure control state, invisible to the model. No dangling, by construction. (A benign `/ask` is the same rule with no parking; the eager append at handlers.js:1365 goes away and the loop's `messages` get the live request pushed explicitly.)
2. **The dispatcher owns recording, for every ask type.** Wired with `getMem`. The ask carries the originating request text; the dispatcher pairs it with the outcome at resolution. **PIN keystrokes and prompts are never written.** The capability supplies the `summary` line (default: its result, or *"✓ done"* when silent — which restores the confirmation the `(no output)` polish removed).

**Terminal-states table — every terminal state records; only *pending* is silent (so no ending can leave a dangling request):**

| Terminal state | Recorded as |
|---|---|
| done — success | *"✓ deleted X"* / *"Amora set to off"* / *"memory cleared"* |
| done — lockout (3 wrong PINs) | *"didn't run — locked out"* |
| cancelled | *"cancelled — didn't run"* |
| expired (TTL timeout, owner never replied) | *"expired — didn't run"* |
| *(pending)* | *nothing* |

**Edge case for build (not design):** a turn that answers something *and* parks a ceremony loses the partial answer on yield — rare; flag it.

## 6. Migration order + tests (LOCKED)

**Strangler, not big-bang:** build the one dispatcher *beside* the existing 7-case switch, move types onto it one at a time, suite green at every step.

**Order — riskiest first:**
1. **`ceremony_action`** — the broken one, and the only type touching the agent loop + memory. Highest value + risk → first. Proves the dispatcher + completion-recording end-to-end.
2. **Pickers** (`index`, `mode`, `business_menu`) — single-shot numeric; validate the simple path.
3. **Wizards** (`pin_change`, `business_wizard`) — multi-step; validate the `{ next }` outcome.
4. **`gate_reply`** — **assess before migrating**: the interactive bareguard ask was largely folded into the PIN tier (0.17.6) and fails closed on Beeper; may be vestigial → migrate *or delete*.

**Tests:**
- **Keystone regression — write FIRST, must FAIL on today's code:** destructive request → park → {resolve | cancel | expire} → next turn is a plain question → assert the model does **not** re-issue the action, and `recent.json` reads request→outcome, not a dangling request. *Passing it is the definition of "done."*
- **Per-type characterization:** each migrated type keeps its existing behavior tests green, plus contract assertions (`accepts` gates the answer; `handle` returns the right outcome; `summary` recorded).
- **Memory invariants:** after resolve `recent.json` has (request, summary); the PIN digits are **never** in `recent.json`; a pending ask records nothing; cancel/expire/lockout each record their line.
- Full suite green at every step.

---

## Non-goals / YAGNI
- No customer-facing structured flows (booking pickers, etc.) — contract stays principal-aware but we build none.
- No change to the governance *decision* core (`runGovernedAction` floor → classify → ceremony → execute → audit) — only how its `NEEDS_CEREMONY` is parked/resumed/recorded.
- Catastrophic stays a hard wall (never an ask).
