# multis Knowledge Base

## Vision and Principles
Local-first personal chatbot. Node.js vanilla, minimal deps, each POC < 500 lines.
-> docs/00-context/vision.md

## Architecture
Platform adapters (Telegram, Beeper) -> message router -> skills/indexer/LLM. SQLite FTS5 for persistence.
-> docs/00-context/system-state.md

## Source Tree
Entry: src/index.js. Key modules: bot/, platforms/, governance/, skills/, indexer/, llm/, cli/.
-> docs/00-context/system-state.md (source tree section)

## POC Roadmap
POC1-4 done (bot, skills, indexing, RAG). POC5 next (memory). POC6 (daemon), POC7 (multi-platform) planned.
-> docs/01-product/prd.md

## Multi-Platform Strategy
Three paths: Telegram (mandatory), Beeper Desktop API localhost:23373 (opt-in), self-hosted Matrix (fallback).
-> docs/02-features/multi-platform.md

## RAG Pipeline
Document upload/index -> FTS5 search -> buildRAGPrompt -> LLM -> answer with citations.
-> docs/02-features/rag.md

## Memory and Indexing (comprehensive)
Document indexing (parse → chunk → store), conversation memory (capture → summarize → index), search (FTS5 + ACT-R), scope enforcement, RAG prompt composition. End-to-end reference.
-> docs/02-features/memory-indexing.md

## Chat Modes
Beeper per-chat modes: personal (self-chat, natural language) vs business (auto-respond to others).
-> docs/02-features/chat-modes.md

## Bot Commands
Telegram prefix: `/`. Beeper prefix: `//`. Access levels: anyone, paired, owner, self.
-> docs/04-process/commands.md

## Configuration
Runtime config: ~/.multis/config.json. Secrets: .env. Governance: ~/.multis/governance.json.
-> docs/04-process/dev-workflow.md

## Adding Commands
Handler in src/bot/handlers.js, case in createMessageRouter switch, update help text.
-> docs/04-process/dev-workflow.md (adding commands section)

## Adding LLM Providers
Extend LLMProvider in src/llm/base.js, add to client.js factory, add env var to config.js.
-> docs/04-process/dev-workflow.md (adding providers section)

## Constraints and Risks
Node.js only, single user, offline except LLM calls. Beeper Desktop API may change.
-> docs/00-context/assumptions.md

## Testing
243 tests: 181 unit, 62 integration, 0 automated e2e. Coverage analysis, gap tracking, manual smoke checklist.
-> docs/04-process/testing-guide.md

## Key Decisions
9 decisions logged: Node.js over Python, Telegram mandatory, Beeper Matrix rejected, Desktop API accepted, SQLite FTS5, chat modes, implicit ask.
-> docs/03-logs/decisions-log.md
