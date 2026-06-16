
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

**AI agent that lives in your chat apps**. Controls your machine, remembers your conversations, searches your documents — with guardrails so it doesn't go rogue. OpenClaw without the bloat."

## Why multis?

- **Local-first:** Your data never leaves your machine
- **All your chats, one config:** Telegram, WhatsApp, Signal, Discord — via Beeper bridges or self-hosted Matrix
- **LLM agnostic:** Anthropic, OpenAI, Ollama — swap providers without code changes
- **Persistent memory:** ACT-R activation decay keeps recent context hot, old conversations fade naturally
- **Document-aware:** Indexes PDFs and DOCX with hierarchical section-aware chunking, answers with citations
- **Governed:** bareguard 0.7.0 Gate — one `humanChannel` for every ask/halt (incl. always-ask-before-exec via the `flags` primitive), structured JSONL audit, USD budget cap with LLM-cost accounting, command/path allowlists, secrets redaction, `limits.maxToolRounds` cap

## Quick Start

```bash
npm install
npx multis init         # interactive setup wizard
multis start            # run as background daemon
```

See the **[Customer Guide](docs/01-product/customer-guide.md)** for full setup instructions, command reference, and troubleshooting.

### Beeper support runs through beeperbox

multis's Beeper integration is provided by **[beeperbox](https://github.com/hamr0/beeperbox)** — a Docker container that exposes Beeper's watch/send capabilities as MCP verbs. multis talks to beeperbox's **MCP transport** on `:23375` (cursor-based `poll_messages`, exact-id echo-guard, `send_message`); a bare local Beeper Desktop (which has no MCP transport) is no longer a target of the adapter. beeperbox runs on your laptop, a Raspberry Pi, or a VPS — headless, no GUI display needed.

```jsonc
// ~/.multis/config.json
"platforms": {
  "beeper": {
    "mcp_url": "http://localhost:23375",    // beeperbox MCP transport
    "mcp_token": "<MCP_AUTH_TOKEN, if set>" // optional; loopback needs none
  }
}
```

Set `BEEPER_TOKEN` (or `platforms.beeper.token`) too — the same token beeperbox uses — for asset/attachment retrieval. Validated end-to-end against a beeperbox 0.6.0 container.

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
│  Governance (bareguard Gate · gate.jsonl audit)   │
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
- **Run commands** — `/exec ls ~/Documents` with bareguard governance (command + path allowlists, budget cap, single humanChannel for approvals)
- **Index documents** — Upload PDFs and DOCX files, or `/index <path>`. Hierarchical chunking preserves document structure.
- **Chat modes** — Set any Beeper chat to `business` (auto-respond), `silent` (archive + search), or `off` (ignore)
- **Audit everything** — Append-only tamper-evident log of all commands and actions

## Roadmap

- [x] POC 1: Telegram bot + pairing
- [x] POC 2: Skills (shell exec, file read, governance via bare-agent Loop policy)
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
├── governance/           # Audit logging (governance.json config read by bare-agent policy)
├── skills/               # Shell exec, file read (governance stripped — Loop policy gates)
├── config.js             # ~/.multis/config.json + .env loader
└── index.js              # Entry point
```

## License

MIT
