# Implementation Log

## 2026-02-09: POC1 — Telegram Echo Bot (a889fe5)
- Telegraf bot with pairing code auth
- Deep link + manual `/start` pairing
- Echo handler for all text messages
- Config: `.env` + `~/.multis/config.json`

## 2026-02-09: POC2 — Basic Skills (63e0da3)
- `/exec`, `/read`, `/skills`, `/help` commands
- Governance enforcement: allowlist/denylist/path restrictions
- All actions audit logged to `~/.multis/audit.log`
- Owner model: first paired user = owner, `/exec` + `/index` restricted

## 2026-02-09: POC3 — Document Indexing (7ece1c2)
- Ported aurora_context_doc pipeline to Node.js
- PDF (pdf-parse), DOCX (mammoth), MD, TXT parsers
- Hierarchical section-based chunking (2000ch, 200 overlap, sentence boundaries)
- SQLite store with FTS5 for BM25 search
- Activation columns pre-built for ACT-R (POC5)
- Natural language query tokenization with stopword removal + OR joining
- `/index`, `/search`, `/docs` commands + Telegram file upload

## 2026-02-09: POC7 (partial) — Platform Abstraction (ad98ec8)
- Platform abstract class + Telegram/Beeper adapters
- Normalized Message class with cross-platform command parsing
- Beeper Desktop API integration (polling, token auth)
- `//` command prefix for Beeper self-messages
- Platform-agnostic message router in handlers.js
- `setup-beeper.js` token setup wizard

## 2026-02-10: POC4 — LLM RAG + Chat Modes
- Fixed all LLM providers: `options.system` with native per-provider handling
- Created `buildRAGPrompt()` — formats search chunks with source metadata
- `routeAsk`: search → prompt → LLM → answer with citations
- `routeMode`: set chat to personal/business, persisted to config
- Natural language routing: plain text in Telegram → implicit ask
- Beeper: self-chat detection, personal chat → natural language, business → auto-respond
- Added `routeAs` property to Message class
