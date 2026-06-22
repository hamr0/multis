
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

These modes are about **how chats reach multis** — pick one, or run several at once.

| Mode | What you get | What it needs | Best for |
|------|--------------|---------------|----------|
| **Telegram** | A private bot, working in minutes | A bot token. Nothing else. | Getting started, zero infrastructure |
| **beeperbox — local** | WhatsApp/Signal/Discord/… 50+ networks via Beeper, on the same machine as multis | Beeper Desktop + beeperbox alongside multis (your laptop, or a GUI home server) | When Beeper Desktop already runs next to multis |
| **beeperbox — remote** | The same 50+ networks, bridge living elsewhere | beeperbox (container) on a Pi or VPS, reachable over the network | When the bridge should stay off the machine multis runs on |

> **Personal assistant or chatbot? That's set by where *multis* runs — a separate choice from the modes above.** Run multis on a machine you own (your laptop, or a GUI home server) and it's a **personal assistant**: it can act on *that* machine (`/exec`, `/read`) and answer your chats. Run multis on a VPS and it's an **always-on chatbot**: it controls the VPS, not your personal files. The mode above decides *how chats get in*; this decides *what multis can do*. (A GUI home server gives you both at once — personal-assistant reach **and** always-on.)

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
| *plain text*, or `/ask` | Drives the full tool-using agent — searches your indexed documents (answering **with citations**), and when you ask it to *find a file, read something, or run a command* it uses its tools and does it rather than telling you to do it yourself |
| `/index <path> public\|admin` | Ingests a PDF / DOCX / Markdown file (parsed + chunked via litectx), scoped to the public KB or your own private (owner-only) knowledge |
| `/exec`, `/read` | Runs a shell command or reads a file **on your machine** — gated, PIN-protected, owner-only |
| `/mode business` on a chat | Turns that chat into an auto-responder that answers from your KB and **escalates to you** when a human is needed |
| `/remember`, `/memory` | Keeps durable notes per chat; recent context stays hot and old context fades, so it remembers what matters |
| `/remind`, `/cron` | Schedules one-shot reminders and recurring tasks that survive restarts |

Single-owner by design: the **owner** is one identity that can span any number of trusted devices sharing the account and can do everything; a **customer** in a business chat just gets answers and never reaches a host tool. Host actions resolve through one governed core (intent → declared capability → ceremony), so there's no raw-shell front door.

## Built on the bare ecosystem

multis is mostly *wiring* — the hard parts are vendored from a family of small, local-first, single-purpose libraries. The value each one buys you, in plain terms (the engineering detail lives behind the links):

**What powers multis today**

- **[bare-agent](https://npmjs.com/package/bare-agent)** — the think → act → observe brain. It's what lets multis *use tools* instead of only talking: call the LLM, run a tool, look at the result, repeat until done — with retries and a circuit breaker so a flaky provider doesn't take the assistant down, and a scheduler so reminders fire on time.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every privileged action passes through. One place that decides *allow / deny / ask-a-human*, keeps an append-only audit log, enforces a USD budget cap, and confines commands and file paths to what you've allowed. This is what makes "it can run things on my machine" a feature instead of a liability.
- **[beeperbox](https://github.com/hamr0/beeperbox)** — 50+ messaging networks behind one clean interface. multis never speaks WhatsApp or Signal directly; it asks beeperbox to *watch*, *send*, and *fetch attachments*, and beeperbox handles the bridges. That's what turns "a Telegram bot" into "an assistant in every chat you have."

**The wider family it can reach into**

These are siblings multis can grow toward — same design DNA, drop-in when the need arrives:

- **[litectx](https://npmjs.com/package/litectx)** — ranked, graph-aware memory with activation decay. **Now adopted** as multis's document index + memory store (M3); the native memory model (promotion ladder) lands in M4.
- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for the agent, so it can read and act on the live web.
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control.

> The bare philosophy: small libraries that each do one thing, run locally, and compose — no 200MB framework, no vendor lock-in. multis is one of the first products built from them.

> **Under the hood** — message router, skills, LLM layer, and the bareguard Gate, with documents + memory stored and recalled through **litectx** (a thin policy wrapper in `src/context`). The full architecture diagram and source map live in **[system-state.md](docs/00-context/system-state.md)**.

## Why not openclaw

multis borrows the good ideas — daemon architecture, the pairing flow, the `skill.md` pattern — and drops the weight:

- **One config, every chat.** openclaw wires up a separate integration per network (WhatsApp Baileys, a Discord bot, Signal…). multis points at beeperbox once and reaches them all.
- **Memory with priorities, not a transcript.** Recent context stays hot, old conversations fade — an activation-decay model (via litectx's ranked recall), not an ever-growing log.
- **Documents it actually understands.** PDF and DOCX are parsed and chunked (via litectx) so an answer can cite the document it came from.
- **A flat router, not a gateway.** No plugin system, no gateway layer — a new command is a handler in one file.

## No Beeper? Self-host Matrix

If you'd rather not route through Beeper at all, you can start from scratch: run your own **Synapse + mautrix bridges** and point multis at them. It's the maximum-sovereignty path — no third party in the chat path — at the cost of more setup. See **[multi-platform docs](docs/02-features/multi-platform.md)**.

## Status

multis is **work in progress**. Built and tested today: Telegram + pairing, shell/file skills behind a single gate, PDF/DOCX/MD indexing and conversation memory on **litectx**, LLM RAG with chat modes and business escalation, the daemon + CLI + PIN auth, the baresuite migration (bare-agent + bareguard + litectx), Beeper via beeperbox, and **M9 intent-first dispatch** — one governed core (intent → declared capability → ceremony, no raw-shell front door) with the single-owner security model.

**Latest (0.17.1):** M9 merged to `main` after a full LIVE‡ security gate (owner/customer boundary, governed-core ceremony, two pre-existing RCEs closed). **Next:** the native litectx memory model (M4 promotion ladder) and `npm install -g` packaging. Full roadmap and per-POC status: **[PRD](docs/01-product/baresuite-migration-prd.md)**.

Stack: Node.js (vanilla, minimal deps) · Telegraf · bare-agent · bareguard · litectx (FTS5 + PDF/DOCX via pdfjs-dist/mammoth). Architecture and source map: **[system-state.md](docs/00-context/system-state.md)** · all docs: **[docs hub](docs/README.md)**.

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE).
