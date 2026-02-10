# Assumptions, Constraints, and Risks

## Constraints

- **Node.js only** — no Python, no compiled languages
- **Vanilla** — standard library first, minimal npm dependencies
- **Each POC < 500 lines** — keeps scope tight
- **Self-contained** — works offline except for LLM API calls
- **Fast setup** — < 5 minutes from clone to running bot
- **Single user** — one instance per person

## Technical Assumptions

- User has Node.js 18+ installed
- User has a Telegram account and can create a bot via @BotFather
- For LLM features: user has at least one API key (Anthropic/OpenAI) or local Ollama
- For multi-platform: user either runs Beeper Desktop or has a VPS for Matrix
- SQLite (via better-sqlite3) for all persistence — no external database

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Beeper Desktop API changes/breaks | Medium | High | Fallback to self-hosted Matrix (Path 3) |
| Beeper E2EE blocks bot access | Confirmed | High | Use Desktop localhost API, bypasses E2EE |
| LLM API costs escalate | Low | Medium | Ollama local fallback, token limits in config |
| better-sqlite3 native build fails | Low | Medium | Prebuilt binaries via prebuild-install |
| Telegram rate limits | Low | Low | Already handled by Telegraf |

## Open Questions

1. Should `multis` include Docker Compose templates for self-hosted Matrix?
2. Bridge auth UX: QR codes via Telegram vs CLI vs web UI?
3. Message deduplication when user has Telegram natively AND via bridge?
4. How to handle VPS downtime gracefully (Telegram keeps working, Matrix goes offline)?
