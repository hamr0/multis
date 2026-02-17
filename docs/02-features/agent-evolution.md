# Agent Evolution: Tier 1-2 Sketch

> Design sketch for evolving multis from chatbot → agent → automated assistant.
> Reference: OpenClaw gateway architecture (docs.openclaw.ai).

---

## Agentic Collaboration Landscape (Feb 2026)

Four protocols/frameworks are emerging as the standard stack for agentic systems. They operate at **different layers** — complementary, not competing:

```
┌─────────────────────────────────────┐
│  AG-UI    Agent ↔ User (frontend)   │  "How does the agent render in a UI?"
├─────────────────────────────────────┤
│  AG2      Agent orchestration       │  "How do I build/wire multi-agent teams?"
├─────────────────────────────────────┤
│  A2A      Agent ↔ Agent (network)   │  "How do agents across systems discover & collaborate?"
├─────────────────────────────────────┤
│  MCP      Agent ↔ Tools/Data        │  "How does an agent access external tools?"
└─────────────────────────────────────┘
```

### AG-UI — Agent-User Interaction Protocol

- **By:** CopilotKit (MIT, 12k+ stars)
- **What:** Event-based protocol (~16 event types over SSE/WebSocket) for rendering agent state in real-time web UIs. Streaming chat, generative UI components, shared state sync, human-in-the-loop interrupts.
- **SDKs:** TypeScript (primary), Kotlin, Go, Dart, Java, Rust, Ruby
- **Adopted by:** LangGraph, CrewAI, Microsoft Agent Framework, Google ADK, AWS Strands, Pydantic AI
- **Relevance to multis:** Low. Our UI is Telegram/Beeper chat, not a web dashboard. Only relevant if we build a web frontend with live agent status. Revisit if Model C (self-hosted for businesses) needs a dashboard.

### AG2 — Multi-Agent Framework (ex-AutoGen)

- **By:** AG2AI, forked from Microsoft Research (Apache 2.0, 4k+ stars, 700k+ monthly PyPI downloads)
- **What:** Python framework for multi-agent orchestration. ConversableAgent primitives, 9 group orchestration patterns (swarm, group chat, sequential, nested), cross-framework interop ("AgentOS" connecting AG2 + Google ADK + OpenAI Agents SDK + LangChain).
- **Runtime:** Python only (>=3.10)
- **Relevance to multis:** None for adoption (wrong language, heavy framework). Worth studying their 9 orchestration patterns for design ideas if we ever need Tier 3 multi-agent coordination. Their swarm and group chat patterns are well-documented.

### A2A — Agent-to-Agent Protocol

- **By:** Google → Linux Foundation (Apache 2.0, 22k+ stars, 50+ launch partners)
- **What:** Wire protocol (JSON-RPC 2.0 over HTTP) for cross-system agent collaboration. Agent Cards (JSON discovery documents like OpenAPI specs) declare capabilities, skills, and connection info. Supports sync, SSE streaming, and async long-running tasks. Agents stay opaque — no shared memory or tools.
- **SDKs:** Python, Go, JavaScript, Java, .NET (language-agnostic by design)
- **Partners:** Atlassian, Salesforce, SAP, ServiceNow, PayPal, LangChain, Cohere, MongoDB
- **Relevance to multis:** **High for Tier 3.** Language-agnostic, HTTP-based, fits Node.js. If multis ever needs to talk to external agents (booking, payment, a customer's own AI), A2A is the emerging standard. Adopt instead of inventing a custom agent-to-agent protocol. See Tier 3 section below.

### What This Means for multis

Tier 1-2 (agent loop, scheduler, heartbeat, hooks) is **internal orchestration** — none of these projects solve that problem. They solve inter-system, multi-tenant, or frontend problems. Our ~345 lines of Tier 2 code remain the right approach.

The key takeaway: **don't reinvent the wheel at Tier 3.** When external agent collaboration is needed, adopt A2A rather than designing a custom message bus.

---

## Current State (Tier 1 — DONE)

multis already has a working agent loop. The LLM decides when to use tools.

```
user message → resolveAgent → buildMemorySystemPrompt
  → runAgentLoop(llm, messages, toolSchemas, tools)
    → LLM returns tool_use → executeTool → feed result back → loop
    → LLM returns text → done
  → send response → memory capture (if threshold)
```

**What's built:**
- `runAgentLoop()` — multi-round tool calling with max iterations (`handlers.js:586`)
- `src/tools/definitions.js` — 25+ tools across filesystem, shell, desktop, Android
- `src/tools/registry.js` — platform filtering, owner-only gating, config overrides
- `src/tools/executor.js` — dispatch + audit logging
- Multi-agent: persona registry, @mention routing, per-chat assignment, mode defaults
- Governance: allowlist/denylist on exec, path restrictions on file tools

**What OpenClaw has that we don't (yet):**

| OpenClaw Feature | multis Equivalent | Gap |
|------------------|-------------------|-----|
| Agent tool loop | `runAgentLoop()` | None — done |
| Multi-agent routing | `resolveAgent()` + config.agents | None — done |
| Cron scheduler | Blueprint §9 designed | **Not built** |
| Heartbeat (periodic awareness) | — | **Not designed** |
| Hooks (event-driven) | — | **Not designed** |
| Broadcast groups (parallel agents) | — | Future (Tier 3) |
| Agent handoffs (@billing mention) | Blueprint §16 sketched | Future |
| Session isolation (JSONL transcripts) | Per-chat memory files | Equivalent |

---

## Tier 2A: Scheduler (cron + reminders)

### What it does

Admin creates scheduled tasks via chat. Tasks run as agent turns — the LLM executes with full tool access at the scheduled time.

### User interface

```
/remind 2h Follow up with Alice about the proposal
/remind tomorrow 9am Check order status for client #472
/cron 0 7 * * 1-5 Morning brief: summarize overnight messages across business chats
/cron 0 9 * * 1 Weekly digest of all customer conversations
/jobs           — list active jobs
/cancel <id>   — cancel a job
```

### Architecture

```
~/.multis/data/cron/
  jobs.json         — persistent job list
  runs/
    <jobId>.jsonl   — execution history per job
```

#### Job schema

```json
{
  "id": "j_1739...",
  "type": "once | recurring",
  "schedule": "2h | 0 7 * * 1-5",
  "nextRun": "2026-02-16T14:00:00Z",
  "action": "Follow up with Alice about the proposal",
  "createdBy": "8503143603",
  "deliverTo": "tg-8503143603",
  "status": "active | paused | done",
  "agentId": "default",
  "createdAt": "2026-02-16T12:00:00Z"
}
```

#### Components

```
src/scheduler/
  index.js      — Scheduler class: load jobs, tick loop, persist
  parser.js     — parse "/remind 2h ..." and "/cron ..." into job objects
  runner.js     — execute a job: build agent turn, run tool loop, deliver result
```

#### Execution flow

```
Scheduler.tick() runs every 60s
  │
  ├─ For each job where now >= nextRun:
  │   ├─ Build messages: [{ role: 'user', content: job.action }]
  │   ├─ Load agent (job.agentId) from registry
  │   ├─ Run agent loop (same runAgentLoop, full tool access)
  │   ├─ Deliver result to job.deliverTo via platform.send()
  │   ├─ Log run to runs/<jobId>.jsonl
  │   ├─ If recurring: compute nextRun from cron expression
  │   └─ If once: set status = 'done'
  │
  └─ Persist updated jobs.json
```

#### Key decisions

- **Runs inside the daemon** — no separate process, no PM2. `setInterval` at 60s.
- **Agent turns, not raw commands** — the LLM gets the action text and decides what tools to use. "Morning brief" triggers search + summarize, not a hardcoded script.
- **Owner-only** — customers cannot create jobs. Customer "remind me" → note to admin.
- **Delivery = platform.send()** — result goes to the chat the owner specified (or admin chat by default).
- **Persistent** — jobs.json survives restarts. On startup, scheduler loads and resumes.
- **Cron parsing** — use `cron-parser` (tiny, well-maintained, 0 deps) for 5-field expressions. Relative times ("2h", "tomorrow 9am") parsed with vanilla Date math.
- **Max runtime** — 60s timeout per job execution. If the agent loop hangs, kill it and log failure.
- **Run history** — append-only JSONL per job. Prune runs older than 30 days.

#### Size estimate

- `parser.js` — ~60 lines (parse remind/cron syntax)
- `index.js` — ~80 lines (tick loop, persist, load)
- `runner.js` — ~40 lines (build agent turn, deliver)
- Handler additions — ~30 lines (routeRemind, routeCron, routeJobs, routeCancel)
- Total: **~210 lines**

---

## Tier 2B: Heartbeat (periodic awareness)

### What it does

Every N minutes (default 30), the agent gets a "check-in" turn. It reviews recent activity and decides if anything needs attention. Unlike cron (precise schedule, specific task), heartbeat is ambient awareness.

### How it works

```
Every 30 minutes (configurable):
  │
  ├─ Collect: unread business messages, pending escalations, overdue reminders
  ├─ Build prompt: "Here's what happened since last check: [summary]. Any action needed?"
  ├─ Run agent loop (with tools)
  ├─ If agent decides something matters → notify admin via admin_chat
  └─ If nothing → no output (silent)
```

### Config

```json
{
  "heartbeat": {
    "enabled": false,
    "interval_minutes": 30,
    "active_hours": { "start": 7, "end": 23 },
    "timezone": "Europe/Amsterdam",
    "checklist": [
      "unresponded business messages older than 1 hour",
      "escalations not yet handled",
      "reminders due in next 30 minutes"
    ]
  }
}
```

### Key decisions

- **Disabled by default** — opt-in. Most personal users don't need it.
- **Active hours** — no 3am notifications. Timezone-aware.
- **Checklist is LLM-interpreted** — the agent reads the checklist items and uses tools to check each one. Not hardcoded logic.
- **Runs in main session** — uses admin memory context, same as a regular admin /ask.
- **Batched** — one heartbeat = one agent turn that checks everything, not N separate checks.

### Why separate from cron

| | Cron | Heartbeat |
|---|------|-----------|
| Trigger | Exact time/schedule | Periodic interval |
| Action | Specific task ("summarize X") | Open-ended awareness ("anything need attention?") |
| Output | Always delivers result | Only if something matters |
| Created by | User (/remind, /cron) | Config (enabled once) |

### Size estimate

- `src/scheduler/heartbeat.js` — ~60 lines (interval, active hours check, build prompt, run)
- Config additions — ~5 lines in config template
- Total: **~65 lines**

---

## Tier 2C: Hooks (event-driven automation)

### What it does

User-defined triggers that fire on events. "When X happens, do Y."

### Events

| Event | Fires when | Example use |
|-------|-----------|-------------|
| `message:business` | Incoming message in business-mode chat | "Log all customer messages to a spreadsheet" |
| `escalation` | Tier 4 escalation triggered | "Send Pushover notification to my phone" |
| `capture` | Memory capture completes | "If capture mentions a deadline, create a reminder" |
| `index` | Document indexed | "Notify admin with summary of what was indexed" |
| `cron:fail` | Cron job fails | "Alert admin" |

### Hook format

```
~/.multis/hooks/
  on-escalation.sh       — shell script, runs on escalation event
  on-capture.js          — Node.js module, exports async handler(event)
```

### Key decisions

- **Phase this in gradually** — start with shell hooks only (simplest). Node.js module hooks later.
- **Fire-and-forget** — hooks run async, don't block the main flow.
- **Timeout** — 10s max per hook. Kill if hangs.
- **Not in first implementation** — hooks are Tier 2C, lower priority than scheduler (2A) and heartbeat (2B). Only build if a real use case demands it during dogfooding.

### Size estimate

- `src/hooks/runner.js` — ~50 lines (discover hooks, match event, spawn)
- `src/hooks/events.js` — ~20 lines (event definitions, emit helper)
- Total: **~70 lines** (when built)

---

## Tier 3: Multi-Agent Orchestration (future, not planned)

For reference. Only relevant if multis becomes multi-tenant or needs external agent collaboration.

### What OpenClaw has

- **Broadcast groups** — same message → multiple agents in parallel, isolated sessions
- **Agent handoffs** — @billing in response → transfers chat to billing agent with context
- **Gateway** — central process that owns all connections, routes messages, manages sessions

### Adopt A2A, don't reinvent

If Tier 3 is ever needed, use the **A2A protocol** (Google → Linux Foundation) instead of building a custom agent-to-agent message bus. A2A provides:

- **Agent Cards** — JSON discovery documents declaring capabilities, skills, auth requirements. multis would publish its own Agent Card describing what it can do.
- **Standard wire protocol** — JSON-RPC 2.0 over HTTP. No custom transports to maintain.
- **Task lifecycle** — submitted → working → input-required → completed/failed/canceled. Built-in long-running task support.
- **Opacity** — agents collaborate without sharing internal state, memory, or tools. multis keeps its memory/FTS/governance private.
- **JS SDK available** — `a2a-sdk` on npm, fits our Node.js stack.

**What this replaces from the original design:**

| Original plan | A2A equivalent |
|---------------|----------------|
| Agent-to-agent message bus | JSON-RPC over HTTP (standard) |
| Coordination protocol (fan-out, wait-for-all) | A2A task lifecycle + streaming |
| Custom discovery | Agent Cards |
| Session isolation per agent | Opacity by design |

**What A2A does NOT replace** (still build ourselves):
- Internal persona routing (`resolveAgent()` — already done)
- Internal parallel execution (if ever needed, ~50 lines of Promise.all)
- Broadcast groups (internal concern, not cross-system)

### When to build

Never, unless:
- A real use case requires multis to call an external agent (booking, payment, customer's AI)
- Multiple users need different agents handling their chats simultaneously
- The single-agent + tools model can't handle the complexity

The agent loop + tools + scheduler covers 95% of personal assistant use cases. Multi-agent orchestration is for platforms, not personal tools. When the time comes, adopt A2A — don't invent a protocol.

---

## Implementation Order

```
                        NOW
                         │
  ✅ Tier 1: Agent loop  │  All done (runAgentLoop, tools, multi-agent personas)
                         │
  ┌──────────────────────┤
  │ Tier 2A: Scheduler   │  ~210 lines. Phase C in roadmap.
  │  /remind, /cron      │  Prerequisite: none. Uses existing runAgentLoop.
  │  /jobs, /cancel      │
  ├──────────────────────┤
  │ Tier 2B: Heartbeat   │  ~65 lines. After scheduler works.
  │  Periodic awareness   │  Prerequisite: Tier 2A (shares scheduler infra).
  ├──────────────────────┤
  │ Tier 2C: Hooks       │  ~70 lines. Only if dogfooding demands it.
  │  Event-driven         │  Prerequisite: none.
  └──────────────────────┤
                         │
  ○ Tier 3: Multi-agent  │  Not planned. Use A2A protocol (not custom).
    orchestration        │  Only if external agent collaboration needed.
                         │
                       FUTURE
```

Total new code for Tier 2 (all three): **~345 lines** — well within the <500 line POC constraint.

---

## Comparison: multis vs OpenClaw

| Dimension | OpenClaw | multis |
|-----------|----------|--------|
| **Scale** | Multi-tenant, 40+ channels, teams | Single-user, 2-3 channels |
| **Gateway** | Full orchestrator (WebSocket + HTTP + UI) | None needed — daemon process is the gateway |
| **Agent model** | Multiple agents per org, broadcast groups | Multiple personas, one active per chat |
| **Scheduling** | Cron + heartbeat, persisted, isolated sessions | Cron + heartbeat, persisted, same session model |
| **Tools** | Plugin system, sandboxed, per-workspace | Registry, platform-filtered, config-gated |
| **Hooks** | Full lifecycle (command, agent, gateway, tool) | Shell scripts on events (simpler) |
| **Sessions** | JSONL transcripts, session keys, compaction | Per-chat memory files, rolling window + FTS |
| **Config** | Complex multi-agent YAML | Single config.json + tools.json |

**Key insight**: OpenClaw's gateway complexity exists because it's multi-tenant and multi-channel at scale. multis doesn't need a gateway — the daemon process *is* the gateway. The agent loop, tools, and scheduler give the same capabilities at personal scale without the orchestration overhead.
