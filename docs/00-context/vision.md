# Vision

## What is multis?

A personal chatbot and assistant that runs on your computer. Control your laptop and ask questions about your documents — from Telegram, Beeper, or any connected messaging platform.

## Core Principles

1. **Local-first** — All data stays on your machine. No cloud storage, no third-party servers for your data.
2. **LLM agnostic** — Works with Anthropic, OpenAI, Ollama, or any provider. Swap without code changes.
3. **Governance-first** — Command allowlist/denylist + audit logs. Every action is validated and recorded.
4. **Vanilla Node.js** — Standard library first, minimal dependencies. No frameworks beyond Telegraf.
5. **Simple** — No overengineering. Each POC < 500 lines.

## What multis Is NOT

- Not a cloud service — runs entirely on the user's machine
- Not a framework — it's a finished product (personal assistant)
- Not multi-user — one instance per person, no shared hosting
- Not a chatbot platform — it's YOUR bot, for YOUR data

## Borrowed Patterns

| Source | What We Took |
|--------|-------------|
| **openclaw** | Daemon architecture, pairing flow, skill.md pattern, memory.md approach |
| **Aurora** | Document indexing pipeline, ACT-R memory model, hybrid retrieval (BM25 + semantic), SQLite schema |
| **mcp-gov** | Governance layer (allowlist/denylist), audit logging, JSON-based policies |

## Differentiators vs openclaw

- Simpler (no gateway, no complex plugin system)
- Document-focused (PDF/DOCX indexing + RAG)
- Multi-platform via Beeper Desktop API / self-hosted Matrix (one integration, many networks)
