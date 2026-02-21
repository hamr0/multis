# Development Workflow

## Running the Bot

```bash
# Set up environment
cp .env.example .env
# Edit .env: add TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, etc.

# Install dependencies
npm install

# Run
node src/index.js
```

## Beeper Setup

```bash
# Ensure Beeper Desktop is running
# Run token setup
node src/cli/setup-beeper.js

# Token saved to ~/.multis/auth/beeper-token.json
# Enable in config: set platforms.beeper.enabled = true
```

## Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `.env` | Project root | API keys, bot token |
| `config.json` | `~/.multis/` | Main config (auto-created from template) |
| `governance.json` | `~/.multis/` | Command allowlist/denylist |

## Adding a New Command

1. Add handler function in `src/bot/handlers.js` (e.g., `routeMyCommand`)
2. Add `case 'mycommand'` to the switch in `createMessageRouter`
3. Add to help text in `routeHelp` and `handleHelp`
4. If owner-only, add `isOwner()` check

## Adding a New LLM Provider

bare-agent handles all provider implementations. To use a different provider:

1. Set `provider`, `model`, and `apiKey` in `~/.multis/config.json` `llm` block
2. OpenAI-compatible APIs: set `provider: "openai"` with custom `baseUrl`
3. Provider adapter: `src/llm/provider-adapter.js` maps config to bare-agent providers

## Testing

No test framework yet. Manual testing:

```bash
# Syntax check all source files
node -e "const fs=require('fs'); require('glob').sync('src/**/*.js').forEach(f => require('./'+f))"

# Or check individual files
node -e "require('./src/llm/prompts')"
```
