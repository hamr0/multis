
```
                                  ╭────────────────────╮
                                  │  ╔╦╗╦ ╦╦ ╔╦╗╦╔═╗   │
                                  │  ║║║║ ║║  ║ ║╚═╗   │
                                  │  ╩ ╩╚═╝╩═╝╩ ╩╚═╝   │
                                  ╰──╮─────────────────╯
                                     ╰── your AI, your machine, every chat.
```

**AI agent that lives in your chat apps**. Controls your machine, remembers your conversations, searches your documents — with guardrails so it doesn't go rogue. OpenClaw without the bloat."

## Why multis?

- **Local-first:** Your data never leaves your machine
- **All your chats, one config:** Telegram, WhatsApp, Signal, Discord — via Beeper bridges or self-hosted Matrix
- **LLM agnostic:** Anthropic, OpenAI, Ollama — swap providers without code changes
- **Persistent memory:** ACT-R activation decay keeps recent context hot, old conversations fade naturally
- **Document-aware:** Indexes PDFs and DOCX with hierarchical section-aware chunking, answers with citations
- **Governed:** Command allowlist/denylist + append-only audit logs

## Quick Start

```bash
npm install
npx multis init         # interactive setup wizard
multis start            # run as background daemon
```

See the **[Customer Guide](docs/01-product/customer-guide.md)** for full setup instructions, command reference, and troubleshooting.

## How It Works

```
┌──────────────┐  ┌──────────────┐
│  Telegram    │  │  Beeper      │  (WhatsApp, Signal, Discord, ...)
│  Bot API     │  │  Desktop API │
└──────┬───────┘  └──────┬───────┘
       │                 │
┌──────▼─────────────────▼──────────────────────┐
│            Message Router                      │
│  commands · RAG ask · chat modes · doc upload  │
└──────┬─────────┬──────────┬───────────────────┘
       │         │          │
┌──────▼──┐ ┌───▼────┐ ┌───▼──────────┐
│ Skills  │ │  LLM   │ │  Indexer     │
│ (shell, │ │ (any   │ │ (PDF, DOCX,  │
│  files) │ │ provider│ │  MD → FTS5)  │
└─────────┘ └────────┘ └──────────────┘
       │         │          │
┌──────▼─────────▼──────────▼───────────────────┐
│  SQLite (FTS5 search · activation decay)       │
│  Governance (allowlist · denylist · audit log)  │
└────────────────────────────────────────────────┘
```

## Why Not openclaw?

Borrowed the good parts — daemon architecture, pairing flow, skill.md pattern — but made it simpler:

- **One config, all chats.** openclaw needs a separate API integration per channel (WhatsApp Baileys, Discord bot, Signal, etc). multis uses one config block and talks to Telegram + Beeper bridges + Matrix — all your networks through one setup.
- **Persistent activation-decay memory.** ACT-R model (ported from Aurora) means recent context stays hot, old conversations fade naturally. Not just a chat log — a memory with priorities.
- **Structured document chunking.** Hierarchical section-aware chunking for PDFs and DOCX (also from Aurora). The bot knows which chapter and section a chunk came from, not just raw text.
- **No gateway, no plugin system.** openclaw has a complex gateway + plugin architecture. multis is a flat router with skills — add a command in one file, done.

## Features

- **Ask questions** — `/ask` or just type naturally. RAG pipeline searches your docs, passes context to the LLM, answers with citations.
- **Run commands** — `/exec ls ~/Documents` with governance enforcement (allowlist/denylist)
- **Index documents** — Upload PDFs and DOCX files, or `/index <path>`. Hierarchical chunking preserves document structure.
- **Chat modes** — Set any Beeper chat to `business` (auto-respond), `silent` (archive + search), or `off` (ignore)
- **Audit everything** — Append-only tamper-evident log of all commands and actions

## Roadmap

- [x] POC 1: Telegram bot + pairing
- [x] POC 2: Skills (shell exec, file read, governance)
- [x] POC 3: Document indexing (PDF/DOCX → FTS5)
- [x] POC 4: LLM RAG + chat modes
- [x] POC 5: Memory (ACT-R activation decay + memory.md)
- [x] POC 6: Daemon + CLI + security + data isolation
- [ ] Dogfood: End-to-end testing, polish, daily use
- [ ] v0.2: Packaging, onboarding docs, `npm install -g` ready
- [ ] POC 7: Multi-platform (Beeper Desktop + self-hosted Matrix) — deferred

## Tech Stack

Node.js (vanilla, minimal deps) · Telegraf · better-sqlite3 · pdfjs-dist · mammoth

## Project Structure

```
src/
├── bot/handlers.js       # Message router + all command handlers
├── platforms/            # Telegram + Beeper adapters, normalized Message
├── llm/                  # bare-agent provider adapter + RAG prompts
├── indexer/              # PDF/DOCX parsing, chunking, SQLite FTS5 store
├── governance/           # Command validation + audit logging
├── skills/               # Shell exec, file read
├── config.js             # ~/.multis/config.json + .env loader
└── index.js              # Entry point
```

## License

MIT
