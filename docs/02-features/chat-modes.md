# Chat Modes

## Overview

Every chat operates in one of three modes that control how multis handles incoming messages. Modes apply per-chat and are set by the owner. `/mode` without args lists all chats with their current modes (no PIN). Setting a mode requires PIN for protected commands.

## Modes

### Off (default for self-chats)

- **Who:** Chats you want multis to completely ignore
- **Commands:** None processed
- **Self-messages without prefix:** Ignored
- **Incoming from others:** Ignored
- **Use case:** Disable multis for a chat entirely — no archive, no response
- **Storage:** None — no logs, no recent, no memory, no DB chunks

### Business

- **Who:** Customers, business contacts
- **Commands:** Self-messages with prefix still processed as commands
- **Self-messages without prefix:** Natural language questions
- **Incoming from others:** Auto-responded via LLM using KB-scoped documents
- **Escalation:** 4-tier (KB → clarify → escalate → human). Bot never promises action
- **Use case:** Auto-reply to customers, support chats

### Silent

- **Who:** Friends, family, group chats you want to archive
- **Commands:** Self-messages with prefix still processed as commands
- **Self-messages without prefix:** Natural language questions
- **Incoming from others:** Archived to memory, **two-stage capture pipeline** (recent → memory.md → DB), **no bot response**
- **Use case:** Passive archival — messages searchable later, no bot interference

## Setting a Mode

Requires owner. Setting a mode requires PIN for protected commands.

### Listing modes (no PIN)

```
/mode              → lists all chats with current modes (Beeper)
/mode              → shows current chat mode (Telegram)
```

### From within a chat (Beeper)

```
/mode off         → this chat becomes off (ignored)
/mode business    → this chat becomes business
/mode silent      → this chat becomes silent (archive only)
```

### From self-chat (interactive picker)

When you run `/mode <mode>` from a self/note-to-self chat, multis lists your recent chats so you can pick which one to set:

```
/mode silent
→ Set which chat to silent?
  1) Alice (+31612345678)
  2) Bob's Pizza Group
  3) Mom
  Reply with number:
```

You can also search by name:

```
/mode silent John    → finds chats matching "John", sets if unique match
/mode business Mom   → finds chats matching "Mom"
```

### Telegram

```
/mode off
/mode business
/mode silent
```

Telegram bot chats are typically used as admin (owner-only). Mode switching is more useful on Beeper where you have multiple chat types.

## Configuration

Mode is per-chat, persisted to `config.platforms.beeper.chat_modes[chatId]`.

### Fallback chain

```
per-chat mode → beeper default_mode → global bot_mode → 'off'
```

- `config.platforms.beeper.chat_modes[chatId]` — explicit per-chat override
- `config.platforms.beeper.default_mode` — Beeper-wide default
- `config.bot_mode` — global default, set during `multis init`
- `'off'` — hardcoded fallback

### Global bot_mode

Set during `multis init`:
- **personal** — you're the only user, all chats default to off (ignored)
- **business** — you have customers, new chats default to business (auto-respond)

## Routing Flow

```
Message arrives:
  │
  ├─ Starts with [multis] → skip (our own response)
  │
  ├─ routeAs: 'silent' → archive to memory, no response
  │
  ├─ isSelf + starts with / (personal chats only on Beeper) → parse as command
  │
  ├─ isSelf + personal/self chat → routeAs:'natural' → LLM ask
  │
  ├─ !isSelf + mode=business → routeAs:'business' → LLM auto-respond
  │
  ├─ !isSelf + mode=silent → routeAs:'silent' → archive only
  │
  └─ else → ignore
```

## Privilege Model

| Capability | off | business | silent |
|------------|-----|----------|--------|
| Owner commands (exec, read, index) | No | No | No |
| `/ask` and `/search` | No | Auto (incoming) | No |
| `/mode` (change modes) | Yes (PIN) | Yes (PIN) | Yes (PIN) |
| Memory capture | No | Yes | Yes (two-stage: recent → memory.md → DB) |
| Bot responds to others | No | Yes | No |

### Restrictions

- Personal/note-to-self chats cannot be set to `silent` or `off` (blocked in `/mode`)
