
```
                                  ╭────────────────────╮
                                  │  ╔╦╗╦ ╦╦ ╔╦╗╦╔═╗   │
                                  │  ║║║║ ║║  ║ ║╚═╗   │
                                  │  ╩ ╩╚═╝╩═╝╩ ╩╚═╝   │
                                  ╰──╮─────────────────╯
                                     ╰── your AI, your machine, every chat.
```

<p align="center">
  <img src="https://img.shields.io/badge/status-WIP-e8a33d" alt="status: work in progress">
  <img src="https://img.shields.io/github/package-json/v/hamr0/multis?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

> **🚧 Work in progress.** The core is built and tested; a live end-to-end verification pass stands between here and the first tagged release. See [Status](#status).

**A local-first chatbot and assistant for personal and small-business use.** Run it as your own *personal assistant* — ask it about your documents, let it run things on your machine — or point it at a *customer-facing chat* and let it answer on your behalf from your knowledge base. Either way it lives in the chat apps you already use, runs on *your* computer so your conversations and files never leave home, and puts a single governance gate between the AI and anything that matters.

Think of it as a private assistant with your laptop's keys — but one that always asks before it does anything you'd want to be asked about.

**Connects to:**
- **Today** — Telegram (native bot), plus WhatsApp · Signal · Discord · iMessage · Instagram · Messenger and 50+ networks through [Beeper](#connection-modes). (Prefer no Beeper at all? [Self-host Matrix](#no-beeper-self-host-matrix).)
- **Planned** — the live web (via [barebrowse](https://npmjs.com/package/barebrowse)) and Android / iOS device control (via [baremobile](https://npmjs.com/package/baremobile)).

## Why multis

- **It's already where you are.** No new app to check. Talk to it in Telegram, or through Beeper to reach WhatsApp, Signal, Discord, iMessage, and 50+ other networks — one setup, every chat.
- **Your machine, your data.** multis runs locally. Documents are indexed on disk, conversations are remembered on disk, and nothing is shipped to a third party you didn't choose.
- **It can actually *do* things.** Run a command, read a file, search your documents and answer with citations — not just chat. The reach is real, which is exactly why the guardrails are too.
- **It won't go rogue.** Every privileged action passes through one gate that can allow, deny, or **ask you first** — with a full audit trail and a spend cap. You stay in the loop on anything that touches your machine or your money.
- **Answer customers while you sleep.** Point it at a business chat and it replies in your voice from your knowledge base, escalating to you the moment a human is actually needed.
- **Bring your own brain.** Anthropic, OpenAI, or a fully local Ollama model — swap providers in config, no code changes.

## Connection modes

multis meets you wherever your chats already live. There are **three modes** — pick one, or run several at once.

| Mode | What you get | What it needs | Best for |
|------|--------------|---------------|----------|
| **Telegram** | A private bot, working in minutes | A bot token. Nothing else. | Getting started, zero infrastructure |
| **beeperbox — local** | WhatsApp/Signal/Discord/… 50+ networks via Beeper, on the machine you already use | beeperbox running on your laptop | Everyday use on your own machine |
| **beeperbox — remote** | The same 50+ networks, off your daily driver | beeperbox on a Pi or VPS, reachable over the network | Always-on, no screen attached |

Telegram is always available and needs no extra moving parts. Both beeperbox modes are the **same component** — [beeperbox](https://github.com/hamr0/beeperbox) — just running locally or on another box; the only thing that changes is the `mcp_url` you point at. It exposes Beeper's *watch / send / fetch* capabilities as a small set of MCP verbs, and multis is a **pure MCP client** that never touches Beeper's raw API:

```jsonc
// ~/.multis/config.json
"platforms": {
  "beeper": {
    "mcp_url": "http://localhost:23375",     // beeperbox endpoint — localhost, or a remote box's address
    "mcp_token": "<token, if you set one>"    // optional on loopback, required over a network
  }
}
```

Document indexing from chats (drop a PDF in a Beeper conversation → your KB) rides the same beeperbox verb surface, so it works even against a remote, MCP-only box. Requires beeperbox ≥ 0.8.0. Full per-mode setup is in the **[Customer Guide → Platforms](docs/01-product/customer-guide.md#6-platforms)**.

## Quick start

```bash
npm install
npx multis init         # interactive setup wizard — platforms, LLM, PIN
multis start            # run as a background daemon
```

Then message your bot `/help`. Full walkthrough — setup wizard, every command, troubleshooting — in the **[Customer Guide](docs/01-product/customer-guide.md)**.

## What you can do

The map, not the manual — every command and its full options live in the **[Commands Reference](docs/01-product/commands.md)**.

| You say… | multis… |
|----------|---------|
| *plain text*, or `/ask` | Searches your indexed documents, hands the relevant passages to the LLM, and answers **with citations** |
| `/index <path> public\|admin` | Ingests a PDF / DOCX / Markdown file with section-aware chunking, scoped so customers and admins see different knowledge |
| `/exec`, `/read` | Runs a shell command or reads a file **on your machine** — gated, PIN-protected, owner-only |
| `/mode business` on a chat | Turns that chat into an auto-responder that answers from your KB and **escalates to you** when a human is needed |
| `/remember`, `/memory` | Keeps durable notes per chat; recent context stays hot and old context fades, so it remembers what matters |
| `/remind`, `/cron` | Schedules one-shot reminders and recurring tasks that survive restarts |
| `/admin` | Lets you appoint **limited admins** — staff who can run the knowledge base but never touch your shell |

Role-aware throughout: the **owner** can do everything, a **limited admin** gets the knowledge-base commands without host access, and a **customer** in a business chat just gets answers.

## Built on the bare ecosystem

multis is mostly *wiring* — the hard parts are vendored from a family of small, local-first, single-purpose libraries. The value each one buys you, in plain terms (the engineering detail lives behind the links):

**What powers multis today**

- **[bare-agent](https://npmjs.com/package/bare-agent)** — the think → act → observe brain. It's what lets multis *use tools* instead of only talking: call the LLM, run a tool, look at the result, repeat until done — with retries and a circuit breaker so a flaky provider doesn't take the assistant down, and a scheduler so reminders fire on time.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every privileged action passes through. One place that decides *allow / deny / ask-a-human*, keeps an append-only audit log, enforces a USD budget cap, and confines commands and file paths to what you've allowed. This is what makes "it can run things on my machine" a feature instead of a liability.
- **[beeperbox](https://github.com/hamr0/beeperbox)** — 50+ messaging networks behind one clean interface. multis never speaks WhatsApp or Signal directly; it asks beeperbox to *watch*, *send*, and *fetch attachments*, and beeperbox handles the bridges. That's what turns "a Telegram bot" into "an assistant in every chat you have."

**The wider family it can reach into**

These are siblings multis can grow toward — same design DNA, drop-in when the need arrives:

- **[litectx](https://npmjs.com/package/litectx)** — ranked, graph-aware memory with activation decay (the memory model multis already mirrors, on track to adopt natively).
- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for the agent, so it can read and act on the live web.
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control.

> The bare philosophy: small libraries that each do one thing, run locally, and compose — no 200MB framework, no vendor lock-in. multis is one of the first products built from them.

> **Under the hood** — message router, skills, LLM layer, indexer, and the bareguard Gate over a SQLite (FTS5 + activation-decay) store. The full architecture diagram and source map live in **[system-state.md](docs/00-context/system-state.md)**.

## Why not openclaw

multis borrows the good ideas — daemon architecture, the pairing flow, the `skill.md` pattern — and drops the weight:

- **One config, every chat.** openclaw wires up a separate integration per network (WhatsApp Baileys, a Discord bot, Signal…). multis points at beeperbox once and reaches them all.
- **Memory with priorities, not a transcript.** Recent context stays hot, old conversations fade — an activation-decay model (from Aurora), not an ever-growing log.
- **Documents it actually understands.** Section-aware chunking for PDF and DOCX means an answer can cite the chapter and section it came from.
- **A flat router, not a gateway.** No plugin system, no gateway layer — a new command is a handler in one file.

## No Beeper? Self-host Matrix

If you'd rather not route through Beeper at all, you can start from scratch: run your own **Synapse + mautrix bridges** and point multis at them. It's the maximum-sovereignty path — no third party in the chat path — at the cost of more setup. See **[multi-platform docs](docs/02-features/multi-platform.md)**.

## Status

multis is **work in progress**. Built and tested today: Telegram + pairing, shell/file skills behind a single gate, PDF/DOCX/MD indexing → FTS5, LLM RAG with chat modes and business escalation, activation-decay memory, the daemon + CLI + PIN auth, the baresuite migration (bare-agent + bareguard), Beeper via beeperbox, and the limited-admin (`/admin`) security batch.

**Before the first tagged release:** a live end-to-end verification pass, then merge to `main`. **Then:** native litectx memory and `npm install -g` packaging. Full roadmap and per-POC status: **[PRD](docs/01-product/baresuite-migration-prd.md)**.

Stack: Node.js (vanilla, minimal deps) · Telegraf · better-sqlite3 (FTS5) · pdfjs-dist · mammoth · bare-agent · bareguard. Architecture and source map: **[system-state.md](docs/00-context/system-state.md)** · all docs: **[docs hub](docs/README.md)**.

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE).
