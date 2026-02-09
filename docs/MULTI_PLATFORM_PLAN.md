# Multi-Platform Messaging Plan

**Date:** 2026-02-09
**Status:** Research complete, implementation deferred to POC7

---

## Goal

Personal chatbot accessible across messaging platforms — Telegram, WhatsApp, Signal, Discord, etc. — with one config file, one setup command, one database for all chat history and documents.

---

## Architecture: Two Paths

### Path 1: Telegram (mandatory, zero infra)

- Direct Telegram Bot API via Telegraf
- Already working (POC1-3)
- No server needed — runs on user's machine
- This is the **control channel** — always available, used for setup/admin

### Path 2: Multi-Platform via Matrix (optional, requires VPS)

- Self-hosted Matrix homeserver (Synapse) on user's own VPS
- mautrix bridges for each platform (WhatsApp, Signal, Discord, etc.)
- multis connects as a Matrix bot client
- **Per-user hosting** — each user runs their own server, owns their data

```
┌─────────────────────────────────────────┐
│  User's Machine                         │
│  ┌───────────────────────────────────┐  │
│  │  multis daemon (Node.js)          │  │
│  │  ├── Telegram transport (direct)  │  │
│  │  ├── Matrix transport (client)  ──┼──┼──► User's VPS
│  │  ├── LLM + RAG engine            │  │
│  │  └── SQLite (all data)            │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  User's VPS ($5-10/month)               │
│  ┌───────────────────────────────────┐  │
│  │  Docker Compose                   │  │
│  │  ├── Synapse (Matrix homeserver)  │  │
│  │  ├── mautrix-whatsapp             │  │
│  │  ├── mautrix-signal               │  │
│  │  ├── mautrix-discord              │  │
│  │  ├── mautrix-slack                │  │
│  │  ├── mautrix-gmessages            │  │
│  │  ├── Caddy (reverse proxy + TLS)  │  │
│  │  └── PostgreSQL                   │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

---

## Why Not Beeper?

### What We Tried
- Connected bot to `matrix.beeper.com` as `@avoidaccess:beeper.com`
- Saw all 135 rooms (WhatsApp, Telegram, LinkedIn, Discord bridges)
- Cross-signing setup worked, SSSS recovery key worked

### Why It Failed
- **Beeper iOS hijacks cross-signing keys** every time it opens
- Bot device becomes "unverified" → bridges refuse to share encryption keys
- No programmatic device verification in Beeper
- `bbctl` (bridge-manager) runs bridges locally but doesn't solve the client E2EE problem
- This is Beeper's design, not a bug — they assume their own clients are the only authority

### What Would Fix It
- Beeper adding device verification UI (unlikely, they control the UX)
- Beeper offering an API bot mode that bypasses E2EE (doesn't exist)
- Running Beeper Desktop and piggybacking on its session (fragile, requires desktop app running)

### Scripts Preserved
All Beeper scripts in `scripts/beeper-*.js` are preserved for reference:
- `beeper-setup.js` — Full login + E2EE + cross-signing
- `beeper-validate.js` — Message listener/decryption test
- `beeper-login.js` — Email code → JWT → Matrix token
- `beeper-crosssign.js` — Manual cross-signing with JWT UIA
- `beeper-sign-device.js` — Sign other devices via SSSS
- Technical learnings documented in `.claude/stash/2026-02-09-beeper-e2ee-verification.md`

---

## Why Not Element Hosted?

- [Element](https://element.io) offers Element Server Suite (ESS)
- **Community edition** is free (AGPL, self-host) — but it's the same Synapse setup
- **Enterprise edition** is per-seat pricing, aimed at organizations
- No personal/individual hosted plan
- Element doesn't bundle bridges — you still need mautrix yourself
- Element is just a client + server packaging, not a bridge solution

---

## Self-Hosted Matrix: What's Required

### Per-User VPS Setup

Each multis user who wants multi-platform runs their own:

| Component | Purpose | Resource |
|-----------|---------|----------|
| **Synapse** | Matrix homeserver | ~512MB RAM, Python |
| **PostgreSQL** | Synapse database | ~256MB RAM |
| **mautrix bridges** | Platform connectors | ~50MB RAM each |
| **Caddy** | Reverse proxy + auto TLS | Minimal |
| **Domain** | `matrix.yourdomain.com` | ~$10/year |
| **VPS** | Runs everything | $5-10/month (Hetzner, DigitalOcean) |

**Total: ~1-2GB RAM, $5-10/month**

### What Each Bridge Needs

| Bridge | Auth Method | Maintenance |
|--------|------------|-------------|
| **mautrix-whatsapp** | QR code scan from phone | Re-scan every 14 days if phone inactive |
| **mautrix-signal** | Phone number + PIN | Stable once linked |
| **mautrix-discord** | Bot token or user token | Stable |
| **mautrix-slack** | OAuth or user token | Stable |
| **mautrix-telegram** | Phone number + 2FA | Stable |
| **mautrix-gmessages** | QR code (Google Messages) | Re-scan periodically |
| **mautrix-instagram** | Username + password | May break with Meta changes |
| **mautrix-linkedin** | Cookies (fragile) | Breaks frequently |

### Why Per-User, Not Shared

- **Data sovereignty**: Your WhatsApp sessions, messages, keys stay on YOUR server
- **Security**: Shared server = someone else has your WhatsApp auth tokens
- **Legal**: Hosting other people's messaging sessions has liability
- **Reliability**: One user's bridge crash doesn't affect others
- **Simplicity**: No multi-tenant complexity, no user management

---

## One Config to Rule Them All

### Unified Config (`~/.multis/config.json`)

```json
{
  "telegram_bot_token": "pass:multis/telegram_api",
  "owner_id": 8503143603,
  "allowed_users": [8503143603],

  "platforms": {
    "matrix": {
      "enabled": false,
      "homeserver": "https://matrix.yourdomain.com",
      "user": "@multis:yourdomain.com",
      "password": "pass:multis/matrix_password",
      "device_name": "multis-bot"
    },
    "whatsapp": { "enabled": false },
    "signal":   { "enabled": false },
    "discord":  { "enabled": false },
    "slack":    { "enabled": false }
  },

  "vps": {
    "host": "matrix.yourdomain.com",
    "ssh_key": "~/.ssh/id_ed25519",
    "compose_dir": "/opt/multis-matrix"
  },

  "llm": { ... },
  "memory": { ... },
  "documents": { ... },
  "governance": { ... }
}
```

### How It Works

1. User edits config: enables platforms they want, fills in credentials
2. `multis setup` reads config:
   - Telegram: validates bot token (already working)
   - Matrix: if `vps` configured, deploys Docker Compose to VPS via SSH
   - Bridges: starts only enabled platforms
   - Verification: auto-verified (user is server admin)
3. `multis start` connects to Telegram + Matrix, listens on all bridged rooms
4. All messages (from any platform) → same SQLite → same LLM → same memory

### Setup Flow

```
$ multis init
Welcome to multis!

Step 1: Telegram (required)
  Bot token: pass:multis/telegram_api ✓
  Send pairing code F71491 to @multis02bot

Step 2: Multi-platform (optional)
  Do you want to connect other messaging platforms? [y/N] y

  VPS host: matrix.example.com
  SSH key: ~/.ssh/id_ed25519

  Which platforms?
  [x] WhatsApp
  [x] Signal
  [ ] Discord
  [ ] Slack

  Deploying to matrix.example.com...
  ✓ Synapse running
  ✓ mautrix-whatsapp running
  ✓ mautrix-signal running
  ✓ Bot device registered and verified

  To link WhatsApp: open bot chat, send /bridge whatsapp
  To link Signal: open bot chat, send /bridge signal
```

---

## Verification: How It Works From the Other End

### Self-Hosted (our approach)
- **No verification needed** — you're the server admin
- Bot registers as a Matrix user on YOUR server
- You can disable E2EE entirely, or auto-trust all devices
- Bridges run as appservices (server-side, no device trust needed)

### Why Beeper Was Different
- Beeper's server, Beeper's rules
- THEIR iOS client manages cross-signing
- OUR bot was a guest on their server with no admin privileges

### For Other Users Messaging You
- They don't need to verify anything
- WhatsApp users message your phone number as normal
- Signal users message your Signal as normal
- The bridges translate between platforms transparently
- Users on other platforms don't know or care that Matrix exists in the middle

---

## Implementation Plan (POC7)

### Prerequisites
- POC4 (LLM RAG) — bot needs brains first
- POC5 (Memory) — bot needs conversation context
- POC6 (Daemon + CLI) — `multis init/start/stop` infrastructure

### POC7 Phases

**Phase 1: Matrix client transport**
- Add `src/transport/matrix.js` alongside existing `src/bot/telegram.js`
- Abstract message handling: transport-agnostic handler layer
- Connect to any Matrix homeserver, send/receive messages
- Test with matrix.org free account (no bridges, just Matrix rooms)

**Phase 2: VPS provisioning**
- `multis setup matrix` — deploys Docker Compose to user's VPS via SSH
- Generates `docker-compose.yml` with Synapse + selected bridges
- Configures Caddy for TLS, registers bot user
- Auto-verifies bot device

**Phase 3: Bridge management**
- `/bridge whatsapp` — starts QR code flow via Telegram
- `/bridge signal` — starts phone number flow
- `/bridge status` — shows connected platforms
- `/bridge disconnect <platform>` — tears down a bridge

**Phase 4: Unified message handling**
- All platforms → single message handler → same SQLite
- Message origin tracked (telegram, whatsapp, signal, etc.)
- Reply routing: response goes back to originating platform
- Cross-platform context: "What did I say on WhatsApp yesterday?"

### Files to Create

```
src/transport/
  telegram.js    — existing bot, refactored as transport
  matrix.js      — Matrix client (matrix-bot-sdk)
  router.js      — route messages to/from transports

src/deploy/
  compose.js     — generate docker-compose.yml
  provision.js   — SSH to VPS, deploy stack
  bridge-mgr.js  — manage bridge lifecycle
```

---

## Cost Summary (per user)

| Item | Cost | Notes |
|------|------|-------|
| Telegram | Free | Bot API is free |
| VPS | $5-10/month | Hetzner CX22 or similar |
| Domain | $10/year | Any registrar |
| LLM API | $5-20/month | Depends on usage |
| **Total** | **~$10-30/month** | For full multi-platform |
| **Telegram only** | **$5-20/month** | LLM API only |

---

## Open Questions

1. **Should `multis` include a docker-compose template?** Or link to a separate repo?
2. **Bridge auth UX**: QR codes via Telegram (send image) vs CLI vs web UI?
3. **Fallback if VPS goes down**: Telegram keeps working, Matrix bridges go offline — how to notify user?
4. **Message deduplication**: If user has Telegram natively AND via bridge, avoid double messages
