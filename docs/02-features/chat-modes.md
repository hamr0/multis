# Chat Modes (Beeper)

## Overview

Beeper chats can operate in two modes that control how multis handles messages:

## Modes

### Personal (default)

- **Self-messages with `//`:** Processed as commands
- **Self-messages without `//` in personal/self chats:** Treated as natural language questions (implicit `/ask`)
- **Incoming messages from others:** Ignored
- **Use case:** Your own notes, personal research, talking to your docs

### Business

- **Self-messages with `//`:** Processed as commands
- **Self-messages without `//`:** Natural language questions (same as personal)
- **Incoming messages from others:** Auto-responded via LLM using indexed documents
- **Use case:** Auto-reply to customers, support chats, business contacts

## Setting a Mode

```
//mode personal    → incoming messages ignored
//mode business    → incoming messages auto-responded
```

Mode is per-chat and persisted to `config.platforms.beeper.chat_modes[chatId]`.

Default mode (when no mode is set) comes from `config.platforms.beeper.default_mode` (defaults to `personal`).

## Personal Chat Detection

Beeper self-chats (Note to Self) are detected during startup by checking chat type and participant count. Messages in these chats that don't start with `//` are routed as natural language questions automatically.

## Routing Flow

```
Message arrives in Beeper:
  │
  ├─ Starts with [multis] → skip (our response)
  │
  ├─ isSelf + starts with // → parse as command
  │
  ├─ isSelf + personal chat → routeAs:'natural' → LLM ask
  │
  ├─ !isSelf + mode=business → routeAs:'business' → LLM auto-respond
  │
  └─ else → ignore
```
