# Chat Modes

## Overview

Every chat operates in one of three modes that control how multis handles incoming messages. Modes apply per-chat and are set by the owner. `/mode` without args lists all chats with their current modes (no PIN). Setting a mode requires PIN for protected commands.

## Modes

### Personal (default)

- **Who:** Admin / owner
- **Commands:** Full access (exec, read, index, mode, etc.)
- **Self-messages without prefix:** Natural language questions (implicit `/ask`)
- **Incoming from others:** Ignored
- **Use case:** Your own assistant — notes, research, document queries

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
- **Incoming from others:** Archived to memory (appendMessage + daily log), **no bot response**
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
/mode personal    → this chat becomes personal
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
/mode personal
/mode business
/mode silent
```

Telegram bot chats are typically personal (admin-only). Mode switching is more useful on Beeper where you have multiple chat types.

## Configuration

Mode is per-chat, persisted to `config.platforms.beeper.chat_modes[chatId]`.

### Fallback chain

```
per-chat mode → beeper default_mode → global bot_mode → 'personal'
```

- `config.platforms.beeper.chat_modes[chatId]` — explicit per-chat override
- `config.platforms.beeper.default_mode` — Beeper-wide default
- `config.bot_mode` — global default, set during `multis init`
- `'personal'` — hardcoded fallback

### Global bot_mode

Set during `multis init`:
- **personal** — you're the only user, all chats default to personal
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

| Capability | personal | business | silent |
|------------|----------|----------|--------|
| Owner commands (exec, read, index) | Yes | No | No |
| `/ask` and `/search` | Yes | Auto (incoming) | No |
| `/mode` (change modes) | Yes (PIN) | Yes (PIN) | Yes (PIN) |
| Memory capture | Yes | Yes | Yes |
| Bot responds to others | No | Yes | No |
