
```
                                  ╭────────────────────╮
                                  │  ╔╦╗╦ ╦╦ ╔╦╗╦╔═╗   │
                                  │  ║║║║ ║║  ║ ║╚═╗   │
                                  │  ╩ ╩╚═╝╩═╝╩ ╩╚═╝   │
                                  ╰──╮─────────────────╯
                                     ╰── your AI, your machine, every chat.
```

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/hamr0/multis?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**A personal AI assistant that lives in the chat apps you already use.** Ask it about your documents, let it run things on your machine, or hand it a customer-facing chat to answer on your behalf — all from Telegram, WhatsApp, Signal, or any network you already have open. It runs on *your* computer, so your conversations and files never leave home, and a single governance gate stands between the AI and anything that matters.

Think of it as a private assistant with your laptop's keys — but one that always asks before it does anything you'd want to be asked about.

## Why multis

- **It's already where you are.** No new app to check. Talk to it in Telegram, or through Beeper to reach WhatsApp, Signal, Discord, iMessage, and 50+ other networks — one setup, every chat.
- **Your machine, your data.** multis runs locally. Documents are indexed on disk, conversations are remembered on disk, and nothing is shipped to a third party you didn't choose.
- **It can actually *do* things.** Run a command, read a file, search your documents and answer with citations — not just chat. The reach is real, which is exactly why the guardrails are too.
- **It won't go rogue.** Every privileged action passes through one gate that can allow, deny, or **ask you first** — with a full audit trail and a spend cap. You stay in the loop on anything that touches your machine or your money.
- **Answer customers while you sleep.** Point it at a business chat and it replies in your voice from your knowledge base, escalating to you the moment a human is actually needed.
- **Bring your own brain.** Anthropic, OpenAI, or a fully local Ollama model — swap providers in config, no code changes.

## Connection modes

multis meets you wherever your chats already live. Pick one — or run several at once.

| Mode | What you get | What it needs | Best for |
|------|--------------|---------------|----------|
| **Telegram** | A private bot, working in minutes | A bot token. Nothing else. | Getting started, zero infrastructure |
| **Beeper — lite** | WhatsApp/Signal/Discord/… through your existing Beeper Desktop | Beeper Desktop running on your laptop | Everyday use on the machine you already own |
| **Beeper — container** | The same 50+ networks, headless, no GUI | Docker on a laptop, Raspberry Pi, or VPS | Always-on, runs without a screen attached |
| **Beeper — remote** | multis here, your chats bridged on a box over there | The container on a VPS, reachable over the network | Keeping the bridge off your daily driver |
| **Self-hosted Matrix** | Full control, no Beeper in the path | Your own Synapse + mautrix bridges | Maximum sovereignty |

Telegram is always available and needs no extra moving parts. Everything beyond Telegram is reached through **[beeperbox](https://github.com/hamr0/beeperbox)** — see [*How the chats get in*](#how-the-chats-get-in) below.

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

## How it works

```
┌──────────────┐   ┌────────────────────────────────┐
│  Telegram    │   │  beeperbox (MCP)               │
│  Bot API     │   │  WhatsApp · Signal · Discord…  │
└──────┬───────┘   └───────────────┬────────────────┘
       │                           │
┌──────▼───────────────────────────▼────────────────┐
│                Message Router                      │
│   commands · RAG ask · chat modes · doc upload     │
└──────┬───────────────┬───────────────┬─────────────┘
       │               │               │
┌──────▼──┐      ┌──────▼──┐      ┌─────▼────────┐
│ Skills  │      │   LLM   │      │  Indexer     │
│ (shell, │      │  (any   │      │ (PDF · DOCX  │
│  files) │      │ provider)│      │  · MD → FTS) │
└────┬────┘      └────┬────┘      └──────┬───────┘
     │                │                  │
┌────▼────────────────▼──────────────────▼───────────┐
│  SQLite  (FTS5 search · activation-decay memory)    │
│  bareguard Gate  (allow / deny / ask · audit · cap) │
└─────────────────────────────────────────────────────┘
```

### How the chats get in

Everything past Telegram flows through **[beeperbox](https://github.com/hamr0/beeperbox)**, which exposes Beeper's *watch / send / fetch* capabilities as a small set of MCP verbs (cursor-based `poll_messages`, exact-id echo-guard, `send_message`, `download_asset`). multis is a **pure MCP client** — it never touches Beeper's raw API. The same verb surface is served three ways, so your config doesn't change with your deployment:

```jsonc
// ~/.multis/config.json
"platforms": {
  "beeper": {
    "mcp_url": "http://localhost:23375",     // beeperbox MCP endpoint
    "mcp_token": "<token, if you set one>"    // optional on loopback
  }
}
```

- **Lite** — `BEEPER_API=http://localhost:23373 node mcp/server.js` against your existing Beeper Desktop. Zero-dep, no container.
- **Container** — headless Beeper + MCP in Docker on a laptop / Pi / VPS, no display needed.
- **Remote** — the container on a VPS; multis talks to it over the network on `:23375` only.

Document indexing from chats (a PDF dropped in a Beeper conversation → your KB) rides the same `download_asset` verb, so it works even against a remote, MCP-only beeperbox. Requires beeperbox ≥ 0.8.0.

## Why not openclaw

multis borrows the good ideas — daemon architecture, the pairing flow, the `skill.md` pattern — and drops the weight:

- **One config, every chat.** openclaw wires up a separate integration per network (WhatsApp Baileys, a Discord bot, Signal…). multis points at beeperbox once and reaches them all.
- **Memory with priorities, not a transcript.** Recent context stays hot, old conversations fade — an activation-decay model (from Aurora), not an ever-growing log.
- **Documents it actually understands.** Section-aware chunking for PDF and DOCX means an answer can cite the chapter and section it came from.
- **A flat router, not a gateway.** No plugin system, no gateway layer — a new command is a handler in one file.

## Roadmap

- [x] Telegram bot + pairing
- [x] Skills — shell exec, file read, governed at a single gate
- [x] Document indexing — PDF / DOCX / MD → FTS5
- [x] LLM RAG + chat modes + business escalation
- [x] Activation-decay memory + per-chat profiles
- [x] Daemon + CLI + PIN auth + data isolation
- [x] **baresuite migration** — adopt bare-agent + bareguard as the agent/governance core
- [x] **Beeper via beeperbox** — pure MCP client across lite / container / remote
- [x] **Security batch + limited-admin model** (`/admin`)
- [ ] Live end-to-end verification pass, then merge to `main`
- [ ] Native litectx memory + document index
- [ ] `npm install -g` packaging and onboarding polish

## Project structure

```
src/
├── bot/handlers.js       # Message router + every command handler
├── platforms/            # Telegram + beeperbox-MCP adapters, normalized Message
├── llm/                  # bare-agent provider adapter + RAG prompts
├── indexer/              # PDF/DOCX parsing, chunking, SQLite FTS5 store
├── governance/           # bareguard Gate factory, single humanChannel, audit log
├── skills/               # Shell exec, file read (gated by the Gate, not here)
├── config.js             # ~/.multis/config.json + .env loader
└── index.js              # Entry point
```

Tech stack: Node.js (vanilla, minimal deps) · Telegraf · better-sqlite3 (FTS5) · pdfjs-dist · mammoth · bare-agent · bareguard. Deeper reference: **[docs hub](docs/README.md)** and the [knowledge base](docs/00-context/knowledge-base.md).

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE).
