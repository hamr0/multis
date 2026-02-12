<!-- AURORA:START -->
# Aurora Instructions

These instructions are for AI assistants working in this project.

Always open `@/.aurora/AGENTS.md` when the request:
- Mentions planning or proposals (words like plan, create, implement)
- Introduces new capabilities, breaking changes, or architecture shifts
- Sounds ambiguous and you need authoritative guidance before coding

Use `@/.aurora/AGENTS.md` to learn:
- How to create and work with plans
- Aurora workflow and conventions
- Project structure and guidelines

## MCP Tools Available

Aurora provides MCP tools for code intelligence (automatically available in Claude):

**`lsp`** - LSP code intelligence with 3 actions:
- `deadcode` - Find unused symbols, generates CODE_QUALITY_REPORT.md
- `impact` - Analyze symbol usage, show callers and risk level
- `check` - Quick usage check before editing

**`mem_search`** - Search indexed code with LSP enrichment:
- Returns code snippets with metadata (type, symbol, lines)
- Enriched with LSP context (used_by, called_by, calling)
- Includes git info (last_modified, last_author)

**When to use:**
- Before edits: Use `lsp check` to see usage impact
- Before refactoring: Use `lsp deadcode` or `lsp impact` to find all references
- Code search: Use `mem_search` instead of grep for semantic results
- After large changes: Use `lsp deadcode` to find orphaned code

Keep this managed block so 'aur init --config' can refresh the instructions.

<!-- AURORA:END -->

# multis

Personal chatbot/assistant that runs locally. Control your laptop and query your documents from Telegram, Beeper, or Matrix. Local-first, LLM-agnostic, governance-first.

## Tech Stack

- Node.js >= 20, vanilla (minimal deps)
- Telegraf (Telegram), better-sqlite3 (SQLite + FTS5), pdfjs-dist (PDF.js), mammoth
- Beeper Desktop API on localhost:23373 (opt-in)
- LLM: Anthropic, OpenAI, Ollama (configurable via .env)

## Commands

```
npm install          # install deps
npm start            # node src/index.js
npm run dev          # node --watch src/index.js
npm test             # node --test test/**/*.test.js
```

## Project Layout

| Path | Purpose |
|------|---------|
| src/index.js | Entry point, starts platforms |
| src/config.js | Load ~/.multis/config.json + .env |
| src/bot/handlers.js | Message router, all command handlers |
| src/platforms/ | Platform adapters (telegram.js, beeper.js, base.js, message.js) |
| src/governance/ | Allowlist/denylist validation + audit log |
| src/skills/executor.js | Shell exec, file read |
| src/indexer/ | Doc parsing, chunking, SQLite FTS5 store |
| src/llm/ | LLM providers + RAG prompt builder |
| ~/.multis/ | Runtime data: config.json, governance.json, multis.db, audit.log |

## Key Patterns

1. **Platform abstraction**: All platforms implement base.js, emit normalized Message objects to a shared router in handlers.js
2. **Command routing**: Telegram uses `/` prefix, Beeper uses `//`. Plain text routes to implicit `/ask` (RAG pipeline)
3. **Owner model**: First paired user becomes owner. Owner-only commands: exec, read, index. Check with `isOwner(userId, config)`

## Config and Secrets

- API keys in `.env` (TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, LLM_PROVIDER, LLM_MODEL)
- Runtime config auto-created at ~/.multis/config.json from .multis-template/
- Pairing code auto-generated, printed on startup

## POC Status

POC 1-5 done (bot, skills, indexing, RAG, memory). POC 6 next (daemon + CLI + security + data isolation). POC 7 (multi-platform) planned.

## Constraints

- Each POC < 500 lines
- No frameworks beyond Telegraf
- Single user, no shared hosting
- Telegraf: `bot.on('text')` fires for ALL messages including commands -- filter with `text.startsWith('/')`

## Adding Features

- New command: add handler in handlers.js, add case to createMessageRouter switch, update help text
- New LLM provider: extend LLMProvider in llm/base.js, add to llm/client.js factory, add env var to config.js
- New platform: extend platforms/base.js, add to index.js startup

## Deep Reference

-> docs/KNOWLEDGE_BASE.md (topic index with links to full docs)

<!-- MEMORY:START -->
@.claude/memory/MEMORY.md
<!-- MEMORY:END -->
