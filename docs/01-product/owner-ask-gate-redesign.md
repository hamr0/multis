# M10 — Unified owner-ask gate (ceremony/pending/park-resume redesign)

**Status:** DESIGN — **core LOCKED 2026-06-24** (principle + contract, §1–§3 below). Remaining sections (§4 doors, §5 memory wiring, §6 migration+tests) are OPEN, to design before build.
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

## 4. OPEN — how the two doors create an ask (to design next)

Both the slash door and the LLM door should stop implementing park/resume and instead **construct one ask object and hand it to the dispatcher**. The agent-loop halt (HaltError from the `onToolResult` seam, to stop the model re-calling after a park) is retained but reframed as "the loop yields when an ask is created mid-loop." Kills the two divergent resume paths (`dispatchCapability` vs direct `runGovernedAction`). *To be designed and validated.*

## 5. OPEN — memory wiring specifics (to design next)

The dispatcher needs the per-chat memory manager (`getMem`) — which the `ceremony_action` handler lacks today. Key decision: **the user's original request should enter `recent.json` paired with its outcome at resolution, not eagerly before the loop** (so a parked request can never dangle). Define exactly what `summary` reads like per ask type, and confirm the PIN keystrokes/prompts are excluded. *To be designed and validated.*

## 6. OPEN — migration order + tests (to design next)

Migrate the 7 types onto the contract incrementally (likely: `ceremony_action` first — it's the broken one — then pickers, then wizards), each behind its own red→green test, with a regression test that proves a resolved/parked destructive request is **not** replayed on the next turn (the bug this whole redesign exists to kill). *To be sequenced.*

---

## Non-goals / YAGNI
- No customer-facing structured flows (booking pickers, etc.) — contract stays principal-aware but we build none.
- No change to the governance *decision* core (`runGovernedAction` floor → classify → ceremony → execute → audit) — only how its `NEEDS_CEREMONY` is parked/resumed/recorded.
- Catastrophic stays a hard wall (never an ask).
