# Multi-Platform Messaging

**Status:** Platform abstraction done (POC7 commit ad98ec8), full Matrix integration deferred.

## Three Paths

### Path 1: Telegram (mandatory, zero infra)
- Direct Bot API via Telegraf
- Working since POC1
- Control channel — always available for setup/admin

### Path 2: Beeper Desktop API (viable, requires Desktop running)
- Polls `localhost:23373` for messages across all bridges
- Bypasses E2EE (talks to Desktop directly)
- `/` command prefix for self-messages (personal chats only)
- Chat modes: `personal` (natural language in self-chats) and `business` (auto-respond)
- Token setup via `node src/cli/setup-beeper.js`

### Path 3: Self-Hosted Matrix (fallback, requires VPS)
- Synapse homeserver + mautrix bridges on user's own VPS
- Per-user hosting — each user owns their data
- $5-10/month for VPS + domain
- No verification issues (you're the server admin)

## Why Not Beeper Matrix API?

Attempted and failed (2026-02-09):
- Device verification worked, SSSS/cross-signing joined iOS identity
- Self-messages decrypted successfully
- **Bridge messages blocked** — keys withheld (`m.unverified`)
- WhatsApp on-device bridge: zero messages reach Matrix server
- Node.js Rust SDK lacks `importRoomKeys` (only WASM has it)
- Beeper iOS hijacks cross-signing on every open

Scripts preserved in `scripts/beeper-*.js`, investigation in `.claude/stash/2026-02-09-beeper-e2ee-verification.md`.

## Platform Abstraction (Implemented)

```
src/platforms/
├── base.js       # Platform abstract class (start, stop, send, onMessage)
├── message.js    # Normalized Message (id, platform, chatId, text, routeAs, ...)
├── telegram.js   # Telegram adapter (wraps Telegraf)
└── beeper.js     # Beeper adapter (polls localhost API)
```

### Message Routing

```
Message arrives:
  ├─ text starts with [multis] → skip (our response)
  ├─ isSelf + personal chat + starts with / → command (routeAsk, routeMode, etc.)
  ├─ isSelf + personal chat + no / → routeAs:'natural' → implicit ask
  ├─ !isSelf + business mode → routeAs:'business' → auto-respond via LLM
  └─ else → ignore
```

### Chat Modes (Beeper)

| Mode | Self messages | Incoming messages |
|------|--------------|-------------------|
| **off** (default for self-chats) | Ignored | Ignored |
| **business** | `/` commands + natural language ask | Auto-respond via LLM |
| **silent** | `/` commands + natural language ask | Archived, no response |

Set via `/mode off`, `/mode business`, or `/mode silent`. Persisted to `config.platforms.beeper.chat_modes[chatId]`.

## Config

```json
{
  "platforms": {
    "telegram": { "enabled": true, "bot_token": "..." },
    "beeper": {
      "enabled": true,
      "url": "http://localhost:23373",
      "poll_interval": 3000,
      "command_prefix": "/",
      "default_mode": "personal",
      "chat_modes": {}
    }
  }
}
```

## Bridge Support (via Beeper Desktop)

| Bridge | Auth | Notes |
|--------|------|-------|
| WhatsApp | QR code | On-device bridge |
| Signal | Phone + PIN | Stable |
| Discord | Token | Stable |
| Slack | OAuth | Stable |
| Telegram | Phone + 2FA | Stable |
| LinkedIn | Cookies | Fragile |
| Instagram | Username/password | May break |
