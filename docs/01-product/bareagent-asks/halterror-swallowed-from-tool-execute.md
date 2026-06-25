# bare-agent ask — `HaltError` thrown from a tool's `execute` is swallowed (every other seam re-throws it)

**From:** multis (first baresuite customer), module **M9** (NL-door ceremony fix).
**Against:** bare-agent **0.16.1** (installed npm artifact; behaviour read from source + a failability-proven POC, both line-cited below — not asserted).
**Date:** 2026-06-24.
**Severity:** **LOW** — a consistency/doc-clarity gap, not a correctness hole. multis does **not** need it fixed: the `onToolResult` seam already halts cleanly, and multis ships on that today. Filed per the no-papering-over contract so the inconsistency is recorded, not because anything blocks on it.
**Status:** **OPEN — non-blocking.** multis is fixed at its own boundary (uses the `onToolResult` seam). This ask is purely "should the lib be internally consistent / is the docstring right."

---

## Finding

`Loop.run`'s per-tool **`execute`** catch is the **only** error seam that does **not** re-throw `HaltError`. Every other seam re-throws it so a governance halt exits the loop cleanly; the `execute` catch wraps **all** errors — `HaltError` included — into a `ToolError`, pushes it as a tool result, and **continues the loop**.

Grounded in the installed 0.16.1 source (`node_modules/bare-agent/src/loop.js`):

- **Tool `execute` catch — swallows (the odd one out):**
  ```js
  } catch (err) {                                                    // loop.js:557
    toolError = err instanceof ToolError ? err : new ToolError(err.message, { context: { tool: tc.name } });
    // … pushes a tool-result message and CONTINUES — no `if (err instanceof HaltError) throw err`
  }
  ```
- **Every other seam re-throws `HaltError`:** `onLlmResult` (350), trim-evict (388), context-assembly (407), context-units harvest (445), trim-flush (463), `policy` (535), `onToolResult` (577) — all carry `if (err instanceof HaltError) throw err;`.
- **The docstrings say it propagates:** *"thrown HaltError propagates"* (loop.js:32, :46); *"A throw of `HaltError` exits the loop cleanly"* (loop.js:158). A `HaltError` from a tool body does **neither** — it's downgraded to a `ToolError` and the loop runs on.

### POC — the behaviour, both directions (failability-proven)

A provider that **never stops** calling a tool, run two ways:

| seam the `HaltError` is thrown from | tool invocations | `result.error` | outcome |
|---|---|---|---|
| **`tool.execute`** (the body) | **100** (hits `HARD_ROUND_LIMIT`) | `[Loop] hit internal safety limit of 100 rounds…` | **swallowed → runaway** |
| **`onToolResult`** (gate seam) | **1** | `halt:ceremony-parked` | **clean halt** |

So the halt primitive works perfectly — *from the seams*. Only the tool body is deaf to it.

## Why this bit multis (context, not a complaint)

multis's M9 routes a destructive tool's `execute` through its governed core; when the action needs a PIN it **parks a ceremony** (prompts the owner, defers execution) and must **end the agent turn** so the model can't keep reasoning. The obvious move — `throw new HaltError(...)` from the wrapped `execute` — silently did nothing: a model that kept re-calling the tool re-parked every round until `limits.maxToolRounds` halted it, leaking the halt to chat and never executing the parked action. The docstring ("HaltError propagates") actively pointed us at the wrong mechanism.

## What multis did in the meantime

Per the contract, multis closed this at its **own** boundary — no lib change required:

- `wrapToolThroughCore` flags the park on the per-run `ctx` and returns `''` instead of throwing.
- `runAgentLoop` wraps the bundle's `onToolResult` to `throw new HaltError(..., { rule: 'ceremony-parked' })` when the flag is set — the seam bare-agent **does** honor — and swallows that one rule on the way out (the PIN prompt is the user-facing signal).

This is arguably the *correct* integration anyway (halt from the governance control-plane, not the tool body). It is validated: a deterministic repro (`test/integration/llm-ceremony-halt.test.js`) goes red→green, mutation-proven load-bearing, full suite green.

## The ask (pick one — both are fine for multis; this is bare-agent's call)

This is **not** "add a feature." It's "make the lib match itself." Two coherent resolutions:

- **(A) Make `execute` consistent — re-throw `HaltError` like every other seam.** One line at loop.js:557:
  ```js
  } catch (err) {
    if (err instanceof HaltError) throw err;          // ← match the other seven catches
    toolError = err instanceof ToolError ? err : new ToolError(err.message, { context: { tool: tc.name } });
    …
  }
  ```
  Then a tool body can halt the loop, the docstring becomes true, and multis's `onToolResult` shim becomes unnecessary (simpler consumer). Risk: a tool can now halt the whole agent by throwing — which may be exactly what you *don't* want (see B).

- **(B) Keep swallowing on purpose — but say so.** If "a tool body must not be able to halt the agent; only the gate seams can" is the intended boundary (a defensible design — tools are the untrusted execution, the gate is the control plane), then leave the code and **fix the docs**: amend loop.js:32/:46/:158 to "HaltError propagates **from the gate seams (`policy`/`onLlmResult`/`onToolResult`/trim); a `HaltError` thrown from a tool's `execute` is treated as a tool error**," and point consumers at `onToolResult` for tool-initiated halts.

multis is happy either way — **(B) matches what we already shipped.** The only thing that's actually wrong today is that the code and the docstring disagree.

## Out of scope / non-asks

- Not asking to change `HARD_ROUND_LIMIT`, `limits.maxToolRounds`, or the halt-to-`result.error` contract — those are correct.
- Not blocking anything. multis is fixed and validated against the installed 0.16.1 via the `onToolResult` seam. This is a durability/clarity fix so the next consumer that reaches for `throw HaltError` in a tool body isn't misled by the docstring.
