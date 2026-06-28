# multis Customer Guide

> Your personal AI assistant that runs on your computer. Control your laptop and query your documents from Telegram, Beeper, or both.

---

## Table of Contents

1. [What is multis?](#1-what-is-multis)
2. [System Requirements](#2-system-requirements)
3. [Installation](#3-installation)
4. [Setup Wizard (`multis init`)](#4-setup-wizard)
   - [Step 1: Choose Your Mode](#step-1-choose-your-mode)
   - [Step 2: Connect Platforms](#step-2-connect-platforms)
   - [Step 3: Choose an LLM Provider](#step-3-choose-an-llm-provider)
   - [Step 4: Set a PIN](#step-4-set-a-pin)
5. [Running multis](#5-running-multis)
   - [Starting and Stopping](#starting-and-stopping)
   - [Health Check (`multis doctor`)](#health-check)
   - [Restarting After Changes](#restarting-after-changes)
6. [Platforms](#6-platforms)
   - [Telegram](#telegram)
   - [Beeper](#beeper)
   - [Using Both Together](#using-both-together)
7. [Commands Reference](#7-commands-reference)
   - [Everyone](#everyone-commands)
   - [Owner Only](#owner-only-commands)
8. [Modes: Personal vs Business](#8-modes)
   - [Personal Mode](#personal-mode)
   - [Business Mode](#business-mode)
   - [Silent Mode](#silent-mode)
   - [Setting Modes Per Chat](#setting-modes-per-chat)
9. [Business Persona Setup](#9-business-persona-setup)
10. [Document Indexing](#10-document-indexing)
    - [Supported Formats](#supported-formats)
    - [Indexing from Chat](#indexing-from-chat)
    - [Indexing from Files](#indexing-from-files)
    - [Scopes: Public vs Admin](#scopes-public-vs-admin)
    - [Checking Your Index](#checking-your-index)
11. [Asking Questions (RAG)](#11-asking-questions)
12. [Memory](#12-memory)
13. [Agents](#13-agents)
14. [PIN and Security](#14-pin-and-security)
    - [PIN-Protected Commands](#pin-protected-commands)
    - [Changing Your PIN](#changing-your-pin)
    - [Lockout](#lockout)
15. [Scheduling: Reminders and Cron](#15-scheduling)
16. [Hosting Options: Always-On Setup](#16-hosting-options)
    - [Which Device for Which Use Case](#which-device-for-which-use-case)
    - [Raspberry Pi Setup (Recommended for Business)](#raspberry-pi-setup)
    - [VPS Setup (Telegram Only)](#vps-setup)
17. [Changing Your LLM Provider](#17-changing-your-llm-provider)
18. [Operators & the Single-Owner Model](#18-operators--the-single-owner-model)
19. [Troubleshooting](#19-troubleshooting)
20. [File Locations](#20-file-locations)

---

## 1. What is multis?

multis is a personal AI assistant that runs locally on your computer. It connects to your messaging apps (Telegram, Beeper) and lets you:

- Ask questions about your documents (PDF, Word, Markdown, text)
- Run shell commands on your machine remotely
- Read files from anywhere on your laptop
- Get AI-powered answers with context from your knowledge base
- Manage a business chatbot that auto-responds to customers

Everything stays on your machine. Your documents are indexed locally in SQLite. The only external call is to your chosen LLM provider (Anthropic, OpenAI, or Ollama for fully local).

**Important:** multis must be running on your computer to work. If your laptop is off, asleep, or disconnected, the bot won't respond. For Beeper, the Beeper Desktop app must also be open.

---

## 2. System Requirements

| Requirement | Details |
|-------------|---------|
| **OS** | Linux, macOS, or Windows (with WSL) |
| **Node.js** | v20 or newer |
| **npm** | Comes with Node.js |
| **Internet** | Required for Telegram and cloud LLM providers |
| **Beeper Desktop** | Required only if using Beeper (must be open and logged in) |
| **Disk space** | ~100 MB for the app + your indexed documents |
| **Always on** | Your computer must be running and connected for the bot to respond |

### For Beeper users

Beeper is reached through **beeperbox** (see [Platforms → Beeper](#beeper) for the three deploy shapes). You need:
- A **beeperbox** endpoint reachable by multis — either the Docker container (headless Beeper inside) or beeperbox's lite server pointed at a local Beeper Desktop.
- A Beeper account logged in to whichever Beeper Desktop beeperbox fronts, with the **Developer API enabled** (Settings > Developers > toggle on).
- Whatever runs beeperbox (your computer or an always-on box) must be up whenever you want multis to respond.

### For fully local (no cloud) setup

If you want zero data leaving your machine, use Ollama as your LLM provider. You'll need:
- [Ollama](https://ollama.ai) installed and running
- A model downloaded (e.g. `ollama pull llama3.1:8b`)
- ~8 GB RAM for the default model

---

## 3. Installation

```bash
# Clone or download
git clone https://github.com/youruser/multis.git
cd multis

# Install dependencies
npm install

# Run the setup wizard
npx multis init
```

Or if installed globally:

```bash
npm install -g multis
multis init
```

---

## 4. Setup Wizard

Run `multis init` to set everything up interactively. The wizard walks through four steps and can be re-run at any time to change settings.

### Step 1: What do you want multis to be?

One question picks both the role and the channel — they go together, so there's nothing else to choose:

```
What do you want multis to be?
  1) Personal bot        — just for you, on Telegram. Runs commands, searches your docs.
  2) Personal assistant  — on Beeper. Runs stuff for you AND keeps up with your messengers
                           (WhatsApp, Signal, +50) — logs your contacts, never replies to them.
  3) Business chatbot    — on Beeper. Auto-responds to customers across every channel, escalates to you.
```

- **Personal bot → Telegram.** Just a Telegram bot, owner-only. Nothing else to install.
- **Personal assistant → Beeper** and **Business chatbot → Beeper.** Beeper is the only channel that can *see and respond to your real contacts* across networks — a Telegram bot only sees people who message the bot directly. So both of these run through Beeper, controlled from your Note-to-self chat.

The difference between the two Beeper roles is purely how the bot treats **other people's** messages by default — *assistant* logs them so you can ask about them but never replies; *business* auto-responds. You're always served fully either way, and you can flip any single chat with `/mode` (e.g. tell the assistant to start replying to one person). Re-running `init` keeps your current choice unless you change it.

### Step 2: Connect Platforms

The wizard connects the channel your role implies — Telegram for *personal bot*, Beeper for *assistant*/*business*.

**Telegram** (your personal bot):
1. Open Telegram, search for `@BotFather`
2. Send `/newbot`, pick a name and username
3. Copy the bot token (looks like `123456:ABC-DEF...`) and paste it in
4. The wizard verifies the token, then waits up to 60 seconds for you to open the bot and send `/start` — that pairs you as **owner** (`owner_id`).

**Beeper** (via beeperbox):
1. Get beeperbox running first — the Docker container, or its lite server against your local Beeper Desktop (see [Platforms → Beeper](#beeper) for the shapes and [beeperbox](https://github.com/hamr0/beeperbox) for setup + the Beeper token).
2. The wizard **probes `http://localhost:23375` automatically**: if a beeperbox is already running it shows your connected accounts (WhatsApp, Signal, etc.) and you press Enter to use it — no URL or token to type. Otherwise it asks for the MCP URL, plus an MCP token *only* if you exposed beeperbox over a network. A local/loopback box needs no token — and this MCP token is **not** your Beeper Desktop `BEEPER_TOKEN`.
3. With Beeper you're the **owner via your Note-to-self chat** (no pairing code) — just open Note-to-self and send `/help`.

### Step 3: Choose an LLM Provider

| Provider | Cost | Notes |
|----------|------|-------|
| **Anthropic (Claude)** | Paid API | Default: `claude-haiku-4-5-20251001`. Fast and capable. |
| **OpenAI (GPT)** | Paid API | Default: `gpt-4o-mini`. Also works with OpenRouter, Together, Groq via custom base URL. |
| **Ollama** | Free (local) | Default: `llama3.1:8b`. No data leaves your machine. Requires Ollama installed. |

The wizard verifies connectivity by sending a test message before proceeding.

### Step 4: Set a PIN

Optionally set a 4-6 digit PIN. It guards **destructive actions** before they run — a destructive shell command (`/exec rm …`), clearing a chat's memory (`/forget`), or turning a chat **off** (`/mode … off`). Benign actions (reads, `/index`, `/remember`, other mode changes) run without it. The PIN is hashed and stored locally. You can skip this and set one later with `/pin`.

After completing the wizard, you'll see a summary:

```
Setup complete!
  Mode:     personal
  Telegram: @yourbotname
  Beeper:   WhatsApp, Signal, Telegram
  LLM:      anthropic / claude-haiku-4-5-20251001
  PIN:      enabled
  Config:   ~/.multis/config.json

Run: multis start
```

---

## 5. Running multis

### Starting and Stopping

```bash
multis start      # Start as background daemon
multis stop       # Stop the daemon
multis restart    # Stop + start
multis status     # Check if running (shows PID)
```

For development or debugging, run in the foreground:

```bash
npm start         # node src/index.js
npm run dev       # node --watch src/index.js (auto-restarts on file changes)
```

Or just run `multis` with no arguments to see an interactive menu.

### Health Check

```bash
multis doctor
```

Checks:
- Config file exists and is valid
- LLM provider is reachable
- Database is accessible
- Agents are properly configured
- Platforms are connected

### Restarting After Changes

If you edit `~/.multis/config.json` directly (changing LLM provider, model, adding agents, etc.), you must restart for changes to take effect:

```bash
multis restart
```

Changes made via bot commands (`/mode business`, `/mode`, `/agent`, `/pin`) are applied immediately — no restart needed.

---

## 6. Platforms

### Telegram

**How it works:** multis uses the Telegram Bot API via long polling. Your bot receives messages in real time as long as multis is running.

**Pairing:** The first person to send `/start <pairing_code>` becomes the **owner**. The Telegram bot is then **owner-only**: anyone else who messages it — even with the code — gets `This is a private assistant.` and nothing more (no answer, no pairing). To reach other people, connect them through Beeper, not a second Telegram pairing. The pairing code is printed when multis starts. *(Pairing is Telegram-only — on Beeper there's no code: you're the owner via your Note-to-self chat, detected automatically. See [Beeper](#beeper).)*

**Commands:** All commands use the `/` prefix (`/ask`, `/exec`, `/help`, etc.). Plain text messages are treated as questions.

**File uploads:** Drag and drop a PDF, DOCX, MD, or TXT file into the chat to index it.

**If multis was offline:** Telegram queues messages for ~24 hours. When multis restarts, old messages (>120 seconds) are silently dropped to avoid a flood of stale responses.

### Beeper

**How it works:** multis reaches Beeper through **[beeperbox](https://github.com/hamr0/beeperbox)** — a small server that exposes Beeper's watch/send capabilities as MCP verbs (cursor-based new-message polling, a reliable echo-guard so the bot never answers itself, send). multis is a **pure MCP client** — it does not poll Beeper's raw API itself. This reaches all your Beeper-bridged chats (WhatsApp, Signal, Instagram, etc.) through one bot.

```
  multis  ──MCP(:23375)──▶  beeperbox  ──raw HTTP(:23373)──▶  Beeper Desktop ──▶ bridges
  (policy: modes,           (verbs: cursor watch,            (your account)     WhatsApp
   owner, routing)           echo-guard, send, normalize)                       Telegram
                                                                                 Signal …

  ── the :23375 line is the split: ABOVE = multis decides; BELOW = beeperbox does ──
```

**beeperbox runs three ways — the verbs are identical, so multis is the same in all three (only `mcp_url` changes):**

| Shape | What runs | Best for |
|---|---|---|
| **Full container** | one Docker container = headless Beeper + beeperbox | an always-on box (Pi/VPS), or a laptop without Beeper installed |
| **Lite** | `node mcp/server.js` pointed at your *existing* local Beeper Desktop (`BEEPER_API=http://localhost:23373`) — no Docker, no Electron | a laptop where Beeper is already running |
| **Remote** | the container on a VPS; multis talks to it over the network | a light client (laptop/phone) with the server doing the work |

**Requirements:**
- A reachable beeperbox MCP endpoint (default `localhost:23375`) — pick a shape above.
- A Beeper account logged into whichever Beeper Desktop beeperbox fronts (the container's headless one, or your local app with Settings > Developers > API enabled).
- For **remote**, set an MCP token and use a tunnel/VPN — never expose `:23375` to the open internet.

**Honest limitations:**
- **~25 recent chats.** Beeper's live-sync keeps only the most-recent chats hot, so very idle chats may not surface in the watch feed. This is a Beeper-API limit, not multis's.
- **Attachments work over local and remote** (requires beeperbox ≥ 0.8.0). Receiving a file (PDF/doc) for indexing works on any deploy shape — the bytes come through beeperbox's `download_asset` MCP verb on `:23375`, so a remote MCP-only connection works too (no raw Beeper API needed).
- **Echo-guard is reliable** — beeperbox tags the bot's own sends by exact message id, so multis never responds to itself (no fragile text-matching).

**Commands:** Use the `/` prefix in your personal (Note to Self) chat. Commands are only accepted from messages you send yourself — not from contacts.

**Business mode:** In chats set to business mode, incoming messages from contacts trigger automatic LLM responses. Your self-sent messages in those chats are treated as commands.

**File uploads:** Send a document in Beeper; the bot asks for the scope (public/admin/skip) before indexing. (Requires beeperbox ≥ 0.8.0 — works on local and remote deploys.)

### Using Both Together

The setup for business use is a single channel — **Beeper**:
- Customers message via WhatsApp/Signal/etc. and the bot auto-responds
- You manage the bot, run commands, and receive escalations from your Beeper **Note-to-self** chat

Set this up with `multis init` option 3 (Business chatbot). A Telegram bot can't see your real contacts, so business doesn't use one — your Note-to-self is the control channel.

---

## 7. Commands Reference

### Everyone Commands

| Command | Description |
|---------|-------------|
| `/ask <question>` | Ask a question (searches your documents, then asks the LLM) |
| `/search <query>` | Search indexed documents (no LLM, just FTS5 results) |
| `/docs` | Show how many documents and chunks are indexed |
| `/status` | Bot version, platform, your role, LLM provider |
| `/memory` | List this chat's durable facts + recent episodes (newest first) |
| `/remember <note>` | Save a durable note to this chat's memory |
| `/forget` | Clear this chat's memory and conversation window |
| `/skills` | List available skills |
| `/help` | Show available commands — grouped by intent (Ask / Remember / Schedule / Run / Manage) and filtered to your role; send `/help <command>` (e.g. `/help mode`) for one command's details |
| *(plain text)* | Drives the full tool-using agent (`/ask`): searches your documents and, on your machine, will find/read files and run things directly rather than telling you to do it yourself |

> A message that starts with `/` but isn't a known command (e.g. a pasted path like `/home/you/file.txt`) is treated as plain text, not a command. A genuinely unknown command (e.g. `/frobnicate`) replies with *"Unknown command — try /help"* rather than being silently ignored.

### Owner Commands

The **owner** (set at setup) can do everything below. The owner is one identity that
can span any number of trusted devices/people sharing the Beeper account; everyone
else is a customer and has none of these commands.

| Command | Who | Description |
|---------|-----|-------------|
| `/exec <command>` | Owner | Run a shell command on your machine — benign runs free, destructive needs the PIN, catastrophic (e.g. `rm -rf /`, `dd`, `mkfs`) is hard-blocked |
| `/read <path>` | Owner | Read a file or list a directory (benign — no PIN) |
| `/index <path> <public\|admin>` | Owner | Index a document or directory |
| `/pin` | Owner | Change or set your PIN |
| `/mode [mode] [target]` | Owner | View or set chat modes (business/silent/off). Turning a chat **off** needs the PIN |
| `/agent [name]` | Owner | View or assign an agent to this chat |
| `/agents` | Owner | List all configured agents |
| `/remind <duration> <action>` | Owner | Set a one-shot reminder (e.g. `/remind 30m call dentist`) |
| `/cron <expr> <action>` | Owner | Set a recurring task (e.g. `/cron 0 9 * * 1-5 morning briefing`) |
| `/jobs` | Owner | List all active reminders and cron jobs |
| `/cancel <job-id>` | Owner | Cancel a scheduled job |
| `/plan <goal>` | Owner | Break a goal into steps and execute them |
| `/mode business` | Owner | Business persona menu (setup, show, clear, global default, assign chats) |
| `@agentname <message>` | Owner | Route one message to a specific agent |

---

## 8. Modes

multis has three modes that control how the bot behaves in each chat.

### Personal Mode

The default. The bot responds to your commands and questions. This is for your own use — talking to the bot directly.

### Business Mode

The bot auto-responds to incoming messages from contacts using the LLM and your indexed knowledge base. Used for customer-facing chats where you want the bot to handle questions automatically.

When the LLM determines a customer needs human attention (refunds, complaints, requests for a manager, urgent issues), it uses the `escalate` tool to notify you in the admin chat with the customer's name and reason. The bot continues responding naturally and empathetically — no canned "checking with the team" messages.

**Admin presence pause:** When you (the owner) type directly in a business chat, the bot pauses for 30 minutes (configurable) so you can handle the conversation yourself. Customer messages during the pause are archived silently. The bot resumes automatically when the pause expires.

### Silent Mode

The bot logs all messages and records them as memory for later recall. No responses. Useful for chats you want to monitor without the bot interfering.

### Off Mode

The bot completely ignores messages in this chat. No archiving, no logs, no memory, no responses.

### Setting Modes Per Chat

```
/mode                           # List your recent chats (live) with their current mode
/mode business                  # Set current chat to business mode
/mode silent John               # Set John's chat to silent (searches by name)
/mode off "WhatsApp Group"      # Set a specific chat to off
```

`/mode` with no target lists your **recent** chats live from Beeper (the most recent ~24), each with its current mode — plus any chat you've already set a mode on, so it stays visible even after it drops out of the recent list. A chat that's neither recent nor already configured won't appear; set it by name with `/mode <mode> <name>`, which finds it live. If two chats share the same name (e.g. two messaging threads for one contact), each is tagged with its **last-active date** so you can tell which numbered entry is the live one — you still reply with the number.

You manage Beeper chat modes from your command channel — your Beeper Note-to-self chat (and, if your setup also has a Telegram bot, from Telegram too):

```
/mode business Acme Corp        # Set Acme Corp's Beeper chat to business
/mode silent                    # Set Telegram chat to silent (global)
```

---

## 9. Business Persona Setup

Configure how the bot represents your business to customers.

### Business Menu

```
/mode business
```

Shows a menu with 5 options:

1. **Setup persona** — launches the 5-step wizard
2. **Show persona** — display current business config
3. **Clear persona** — reset to blank
4. **Set as global default** — sets bot_mode to business
5. **Assign chats** — pick Beeper chats to set to business mode

### Setup Wizard (Option 1)

The wizard walks through 5 steps. Re-running shows current values — send "skip" to keep them.

1. **Name** — e.g. "Acme Support" (2-100 characters, or "skip" to keep current)
2. **Greeting** — e.g. "Welcome to Acme! How can I help?" (max 500 chars, or "skip")
3. **Topics** — add as "Topic: Description" (one per line), e.g. "Pricing: Plans and billing". Topics without `:` are accepted as name-only. Send "done" when finished, "skip" to keep current, or "clear" to start fresh
4. **Rules** — custom instructions (max 200 chars each), e.g. "Always respond in Spanish". Send "done" when finished, "skip" to keep current, or "clear" to start fresh
5. **Review & Save** — review the summary, type "yes" to save

Type "cancel" at any step to abort. Any `/command` typed during the wizard cancels it and routes the command normally.

Interactive prompts don't wait forever: a numbered picker (mode/index/business menu) lapses after a few minutes and the setup wizard after a longer window, after which the bot tells you the prompt expired and to re-run the command rather than treating a late reply as a question. Tune the windows under `interaction` in `~/.multis/config.json` (`picker_ttl_minutes`, `wizard_ttl_minutes`). Pending prompts are in-memory only, so restarting multis cancels any half-finished picker.

Escalation notifications are sent automatically to the owner's command channel — your Beeper Note-to-self (and Telegram too, if your setup has a bot) — no manual configuration needed.

### How It Works

When a customer messages a business-mode chat, the bot builds a system prompt from your persona config:

- Identity: "You are Acme Support"
- Greeting instruction
- Numbered topic list with descriptions
- Rules (default: don't make up info, cite sources, be professional + your custom rules)
- Topic boundaries: the bot won't answer questions outside listed topics
- Escalation: the LLM has an `escalate` tool and uses it when the customer needs human attention (refunds, complaints, requests for a manager, urgent issues). Escalation keywords are guidance for the LLM, not hard-coded triggers

The bot always calls the LLM — even when no documents match the question. This means the bot responds naturally instead of sending canned "I don't understand" messages.

---

## 10. Document Indexing

Index your documents so the bot can answer questions about them.

### Supported Formats

| Format | Extension | Notes |
|--------|-----------|-------|
| PDF | `.pdf` | Extracts text with section hierarchy from TOC/outline |
| Word | `.docx` | Converts to HTML, preserves heading structure |
| Markdown | `.md` | Splits on `#` headings |
| Plain text | `.txt` | Indexed as a single chunk |

**Max file size:** 10 MB (enforced before parsing). PDFs are also capped at 2000 pages and parsing is bounded by a wall-clock timeout, so an oversized or malformed document can't exhaust memory. All three are configurable under `documents` in `~/.multis/config.json` (`maxSize`, `maxPdfPages`, `parseTimeoutMs`).

### Indexing from Chat

**Telegram:** Drag and drop a file into the bot chat. It's indexed automatically as public (kb).

**Beeper:** Send a file. The bot asks:
```
Got "manual.pdf". Index as:
1. Public (kb)
2. Admin only
3. Skip
Reply 1, 2, or 3.
```

### Indexing from Files

Use the `/index` command with a file path and scope:

```
/index ~/Documents/manual.pdf public    # Anyone can search this
/index ~/private/notes.md admin         # Only the owner can search this
/index ~/Documents/ public              # Index an entire directory recursively
```

The scope is required — the bot asks for it if you forget.

### Scopes: Public vs Admin

| Scope | Who can search | Use for |
|-------|---------------|---------|
| `public` (or `kb`) | Everyone (customers in business mode, paired users) | Product manuals, FAQs, public knowledge |
| `admin` | Owner / staff | Private notes, internal docs, sensitive info |

Customer messages in business mode search `public` documents plus that customer's own captured chat memory. The owner searches `public` + `admin` — but **not** other customers' captured memory by default. This is deliberate: it stops text a customer planted in their chat from later surfacing in your tool-enabled assistant as if it were a trusted instruction. (Retrieved document and memory text is also fenced as untrusted reference data for the same reason.)

### Checking Your Index

```
/docs
```

Shows:
```
Indexed documents: 5
Total chunks: 142
  pdf: 98 chunks
  docx: 32 chunks
  md: 12 chunks
```

---

## 11. Asking Questions

```
/ask What is the return policy?
```

Or just type the question directly (plain text is treated as `/ask`):

```
What is the return policy?
```

What happens behind the scenes:
1. Your question is searched against the indexed documents (FTS5 full-text search)
2. The top 5 matching chunks are pulled in as context
3. Your conversation history and memory notes are included
4. Everything is sent to the LLM with a system prompt
5. The LLM's answer is sent back to you

If no documents match, the LLM still responds — it just won't have document context.

---

## 12. Memory

Each chat has its own memory that persists across conversations.

### Manual Notes

```
/remember Customer prefers email over phone    # Save a durable note instantly
/memory                                        # List durable facts + recent episodes
/forget                                        # Clear this chat's memory + conversation window
```

- **`/remember <note>`** saves a durable fact for this chat immediately — top trust, never expires. If your note **restates something it already knows** (a moved deadline, a corrected detail, a new weight/address), it **updates that fact in place** and tells you what it replaced (`Noted — updated your earlier note (was: …)`), so a wrong update is visible and you can correct it. Distinct facts are kept side by side.
- **`/memory`** lists this chat's **durable facts and recent episodes**, newest-first, with a count of each. Recall also matches **meaning, not just keywords** — a reworded question still finds the right memory (semantic recall, on by default).
- **`/forget`** wipes this chat's durable memory **and** its conversation window — a clean slate. It's tenant-scoped: it can only ever clear *this* chat, never another's, and never the shared knowledge base.

### Automatic Memory

You don't have to save anything manually — multis learns from use:

1. **Every exchange is recorded as a short-lived episode** for that chat.
2. **The episodes you keep coming back to are promoted to durable facts** — promotion is by genuine use (recalled often within the episode window), copied **verbatim** with no LLM summarization step.
3. **One-off chatter simply expires** (after ~90 days by default — `memory.episode_window_days`); only the thin layer that proves useful persists as durable facts.

This means the bot remembers what's actually proven important across past conversations — not what a summarizer guessed on the spot.

### Memory Scope

- **Admin memory** (your own personal chats, across Telegram + Beeper) shares one `admin` scope.
- **Customer memory** is per-chat (each Beeper contact has their own isolated `user:<chat>` scope — fenced at the store so it can never leak into another chat).

---

## 13. Agents

> **Personas are currently deferred (as of 2026-06-17).** The owner/personal path now always runs an *obedient* base prompt — the assistant follows your orders and uses its tools directly — and a configured `persona` is **not** applied there (it used to *replace* the base prompt, which made the model deflect file/command requests). Agent **routing** (`@mention`, per-chat assignment, the `[name]` prefix) and **business-mode** personas still work; the personal-persona/constitution layer returns with the upcoming memory module. The config below is still read for routing and business mode.

Agents are named personas with different system prompts. You can configure multiple agents and route chats to specific ones.

### Default Setup

By default, there's one agent called `assistant` with a generic persona. This works fine for most uses.

### Custom Agents

Edit `~/.multis/config.json` to add agents:

```json
"agents": {
  "assistant": { "persona": "You are a helpful personal assistant." },
  "sales": { "persona": "You are a sales agent for Acme Corp. Be friendly and focus on closing deals." },
  "support": { "persona": "You are a technical support agent. Be thorough and patient." }
}
```

Restart after editing config: `multis restart`

### Using Agents

```
/agents                    # List all agents
/agent                     # Show which agent handles this chat
/agent sales               # Assign the "sales" agent to this chat
@support how do I reset?   # Route one message to the "support" agent
```

### Agent Routing Priority

1. `@mention` in the message (e.g. `@sales`)
2. Per-chat assignment (set with `/agent`)
3. Mode default (configured in `config.json` `defaults` block)
4. First agent in the registry

---

## 14. PIN and Security

### PIN-Protected Actions

The PIN guards **destructive actions** by *what they do*, not by which command name you typed. An action is classified when it runs:
- **Benign** — reads (`/read`), `/index`, `/remember`, `/status`, non-`off` mode changes, and benign shell (e.g. `ls`, `cat`) — run free.
- **Destructive** — a destructive shell command (`rm <file>`, `rm -rf ./build`, `sudo`, `chmod`…) — *including* anything carrying destructive-intent words (`delete`, `drop`, `truncate`, `destroy`, `purge`, `revoke`, `force-push`) — plus clearing a chat's memory (`/forget`) or turning a chat **off** (`/mode … off`) — require the **PIN**.
- **Catastrophic** — machine-wreckers (`rm -rf` of a root/home target, `dd` to a device, `mkfs`, fork bomb, `shutdown`) — are **hard-blocked**. They never run through the bot, with no PIN override; do those in a real terminal. (There's no legitimate reason to automate them, and it removes a footgun if the assistant is ever fed a malicious instruction.)

When an action needs it, the bot asks for your PIN. After entering the correct PIN, your session is active for 24 hours (configurable).

**While a PIN is pending:** reply your PIN to proceed, or **`cancel`** to abort it. Anything else — a new request, a stray message — doesn't run, doesn't count as a wrong PIN, and isn't answered as a question: you get a **"⏳ Still waiting for your PIN"** reminder and the action stays parked until you reply. Only one action waits at a time, so if you fire several, the rest wait behind the reminder until you clear the first.

A **wrong** PIN doesn't cancel the action — it tells you how many attempts remain and keeps it parked, so your next *correct* PIN still runs it. Three wrong tries trips the [lockout](#lockout) below; a reply during an active lockout is final.

**This applies to the natural-language path too.** If you ask in plain language ("delete the logs in ~/tmp") and the assistant resolves it to a destructive action while your PIN session is stale, it prompts `🔒 That action needs your PIN.` — echoing the **exact resolved command** — and continues the same action once you reply. So rephrasing a command as a sentence can't sidestep the PIN, and you approve what will *actually* run. (`pin_prompt_timeout` in config bounds how long it waits.) For an **app-verb** (e.g. `/mode off`), the prompt names the thing in plain language — `set "Amora" to off` — rather than echoing an internal id; only shell commands show the verbatim command text.

### Changing Your PIN

```
/pin
```

If a PIN is set, you'll be asked to enter your current PIN first, then the new one. If no PIN is set, you go straight to setting a new one.

### Lockout

After 3 wrong PIN attempts, your account is locked for 60 minutes. The bot tells you when the lockout expires.

### Governance

All tool calls (shell commands, file reads, etc.) flow through a **bareguard Gate** (multis is bareguard's first production adopter, pinned to v0.7.0):
- **Allowlist:** Safe commands like `ls`, `cat`, `grep`, `git`, `python`
- **Denylist:** Dangerous commands like `rm`, `sudo`, `chmod`, `shutdown` (matched as regex patterns)
- **Path restrictions:** Only allowed directories (like `~/Documents`) can be read or written
- **Cost cap:** Optional per-run spending limit (set `max_cost_per_run` in config) — covers BOTH LLM tokens and tool execution. On halt, the bot pings you with current spend and asks whether to terminate
- **Secrets redaction:** the bot's own API keys/tokens (`ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, etc.) are stripped from **both** logs automatically — the gate decision log (`gate.jsonl`) and the app audit log (`audit.log`) — so an `/exec` command that happens to contain a secret never persists it in plaintext
- **Exec isolation:** commands run via `/exec` run in a child shell with the bot's own credentials **removed from the environment** — a command (or an LLM-driven action) can't read `$ANTHROPIC_API_KEY` and leak it
- **Owner-only tools:** All host-reaching tools (shell exec, file read/send, system info, opening URLs, notifications, media control) are owner-only and cannot be granted to a customer, even by editing `tools.json` — a customer is never a privileged principal. The `admin` document scope is owner-only too — it is the owner's private knowledge, distinct from the public KB
- **Approvals go to you:** the PIN prompt and any halt notice route to the owner's channel, never to the chat that triggered them — no one can self-approve a privileged action (and on Beeper, whose message loop can't pause for an inline yes/no, a flagged action escalates to that PIN rather than blocking the loop)
- **Audit:** Every gate decision is logged at `~/.multis/logs/gate.jsonl` (structured by phase: gate, record, approval, halt, denied-owner, denied-pin). App-level events (pairing, mode change, etc.) stay at `~/.multis/logs/audit.log`. **Blocked attempts leave a trace too, not just successful ones:** a host action that's denied — a non-owner reaching for a host verb, or a destructive command where the PIN was declined — is recorded in `audit.log` as a `govern` event with `status: denied-owner` / `denied-ceremony` (alongside `executed` and `blocked`), so you can see *who tried what and was stopped*, on both the slash (`/exec`) and natural-language paths

Edit `~/.multis/auth/governance.json` to customize allowed/denied commands and paths.

### Business-mode rate limiting

In business mode each customer is rate-limited so a contact stuck in a loop can't run up your LLM bill or overload the process. Defaults: ~10 messages/minute (burst) and 100/day per customer. When a customer hits the cap, the bot **doesn't go silent** — it sends one short "I've flagged a human to follow up" message and escalates to you, so a genuinely busy customer reaches a person instead of a wall. Tune under `security.rate_limit` in `~/.multis/config.json` (`enabled`, `burst_per_min`, `daily_per_sender`); the message is `business.rate_limit_message`.

### Bounding the agent loop

`llm.max_tool_rounds` (default 5) caps how many tool calls the assistant can chain in a single reply, so it can't run away. Adjust in config.

---

## 15. Scheduling

### Reminders (One-Shot)

```
/remind 30m check email          # 30 minutes from now
/remind 2h call dentist          # 2 hours from now
/remind 1d review proposal       # 1 day from now
```

### Cron Jobs (Recurring)

```
/cron 0 9 * * 1-5 morning briefing       # Weekdays at 9am
/cron 0 18 * * * end of day summary       # Every day at 6pm
/cron 0 0 1 * * monthly report            # First of every month
```

### Managing Jobs

```
/jobs                # List all active jobs with IDs
/cancel abc123       # Cancel a specific job
```

Jobs persist to disk and survive restarts.

### AI-Powered Jobs

Add `--agent` to any reminder or cron job to run the full AI agent instead of just sending text. The agent can use tools (search docs, recall memory, run commands, etc.) and sends the result to your chat.

```
/remind 2h summarize today's messages --agent
/cron 0 9 * * 1-5 morning briefing --agent
/remind 1h check if backup completed --agent
```

Without `--agent`, jobs send the action text as a plain reminder (backward-compatible).

---

## 16. Hosting Options: Always-On Setup

multis only responds when it's running. If your computer is off or asleep, the bot goes silent. Here's how to keep it always-on depending on your use case.

### Which Device for Which Use Case

**Personal use (Telegram only)** — no Beeper needed:

| Device | Cost | Notes |
|--------|------|-------|
| **VPS** (RackNerd, Hetzner, Oracle) | $0-20/year | Best option. Headless, always on. Oracle free tier = $0. |
| **Android** | $0 | Telegram only — runs the Node.js bot under Termux, no host/device control. Must stay on and charged. |
| **Laptop** | $0 | Works but sleeps. Fine for daytime use. |

**Business use (Beeper bridges — WhatsApp, Signal, etc.):**

| Device | Cost | Works? |
|--------|------|--------|
| **VPS** (RackNerd, Hetzner, Oracle) | $5-20/year | **Yes — now the easy option.** Run the beeperbox container (headless Beeper inside, ~600 MB RAM) + multis. Always on. |
| **Raspberry Pi 4/5** | $35-60 one-time | Yes. beeperbox container (arm64 image) + multis. Silent, low power. |
| **Laptop / mini PC** | $0-80 | Yes — beeperbox container, or lite mode against your local Beeper Desktop. Must stay awake. |
| **Android** | $0 | Telegram only — no Docker / Beeper Desktop. |

**Can Beeper run on a VPS now?** Yes — that's exactly what **beeperbox** is for: it containerizes a headless Beeper Desktop (virtual display + supervised Electron) and exposes the MCP verbs multis uses. The old "Beeper needs a GUI display, so no VPS" limitation is gone. Run beeperbox on the VPS and point multis at it (locally, or over a tunnel from a lighter client).

**Bottom line:** For business mode with Beeper bridges, a small VPS or a Raspberry Pi running the beeperbox container is the cheapest, most reliable always-on option.

### Raspberry Pi Setup

A Raspberry Pi 4 (2GB+) or Pi 5 running Raspberry Pi OS with desktop is all you need. Total cost: ~$35-60 for the board + ~$15 for power supply and SD card. Draws ~5W — pennies per month in electricity.

#### What you need

- Raspberry Pi 4 (2GB+ RAM) or Pi 5
- microSD card (32GB+)
- USB-C power supply
- Ethernet cable or WiFi
- Monitor + keyboard for initial setup (can go headless after)

#### Step 1: Install Raspberry Pi OS (Desktop)

1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on your laptop
2. Flash **Raspberry Pi OS (64-bit) with desktop** to the SD card
3. In Imager settings (gear icon), enable SSH and set your WiFi credentials — this lets you manage it remotely later
4. Insert the SD card, connect the Pi, power it on
5. Complete the first-boot setup (locale, password, updates)

#### Step 2: Install Node.js 20

```bash
# Add NodeSource repository
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -

# Install Node.js
sudo apt-get install -y nodejs

# Verify
node --version    # should show v20.x.x
npm --version
```

#### Step 3: Run beeperbox (headless Beeper)

Instead of installing Beeper Desktop directly, run the **beeperbox** container — it bundles a headless Beeper Desktop and exposes the MCP verbs multis talks to. It ships an arm64 image for the Pi. Follow [beeperbox's quick start](https://github.com/hamr0/beeperbox):

```bash
# Needs Docker + the compose plugin (sudo apt-get install -y docker.io docker-compose-plugin)
curl -LO https://raw.githubusercontent.com/hamr0/beeperbox/master/docker-compose.yml
docker compose up -d
```

Then open `http://<pi-ip>:6080/vnc.html` once to sign into Beeper, connect your messaging accounts (WhatsApp, Signal, etc.), enable **Settings > Developers > API**, and save the token to beeperbox's `.env` (`echo "BEEPER_TOKEN=…" > .env && docker compose up -d`). beeperbox persists login across reboots and restarts cleanly.

> No Docker? Use beeperbox **lite mode** instead — `node mcp/server.js` pointed at a local Beeper Desktop. See [beeperbox's docs](https://github.com/hamr0/beeperbox).

#### Step 4: Install and configure multis

```bash
# Install multis
npm install -g multis

# Run the setup wizard
multis init
```

The wizard asks for your beeperbox MCP URL (default `http://localhost:23375`) and an MCP token if you set one, then walks you through Telegram, an LLM provider, and a PIN.

#### Step 5: Start multis and auto-start on boot

```bash
# Start the daemon
multis start

# Verify it's running
multis status
```

beeperbox already auto-restarts via its Docker `restart: unless-stopped` policy (and survives reboots if the Docker service is enabled: `sudo systemctl enable docker`). So you only need a systemd user service for multis:

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/multis.service << 'EOF'
[Unit]
Description=multis AI assistant
After=network-online.target

[Service]
ExecStart=/usr/bin/node /usr/lib/node_modules/multis/src/index.js
Restart=on-failure
RestartSec=10
Environment=HOME=/home/pi

[Install]
WantedBy=default.target
EOF

systemctl --user enable multis
systemctl --user start multis

# Allow user services to run without a login session
sudo loginctl enable-linger pi
```

#### Step 6: Go headless (optional)

Once everything is running, you can disconnect the monitor and manage the Pi over SSH:

```bash
ssh pi@<your-pi-ip>

# Check status
multis status
multis doctor

# View logs
tail -f ~/.multis/logs/daemon.log
```

The Pi sits on your network, always on, running the beeperbox container + multis. Customers message on WhatsApp, the bot responds automatically.

### VPS Setup

A cheap VPS works perfectly for Telegram-only — and now for **Beeper too**: run the beeperbox container on the same VPS (see [Step 3 above](#step-3-run-beeperbox-headless-beeper)) and point multis at `http://localhost:23375`. The steps below cover the Telegram-only base; add beeperbox if you want bridges.

**Cheapest options:**
- **Oracle Cloud Always Free** — 4 ARM cores, 24GB RAM, free forever (if you can get a slot)
- **RackNerd** — 1GB RAM, ~$10-12/year (Black Friday deals)
- **BuyVM** — 512MB RAM, $24/year
- **Hetzner** — 2GB RAM, ~$45/year

```bash
# SSH into your VPS
ssh root@your-vps-ip

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install multis
npm install -g multis

# Setup (Telegram only here; add Beeper by running the beeperbox container first)
multis init

# Start as daemon
multis start
```

For auto-restart on reboot, create a systemd service:

```bash
cat > /etc/systemd/system/multis.service << 'EOF'
[Unit]
Description=multis AI assistant
After=network.target

[Service]
Type=simple
User=multis
ExecStart=/usr/bin/node /usr/lib/node_modules/multis/src/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl enable multis
systemctl start multis
```

---

## 17. Changing Your LLM Provider

### Option 1: Re-run the wizard

```bash
multis init
```

It detects your existing config and lets you change just the LLM step (press Enter to keep other settings).

### Option 2: Edit config directly

Edit `~/.multis/config.json`:

```json
"llm": {
  "provider": "openai",
  "apiKey": "sk-...",
  "baseUrl": "",
  "model": "gpt-4o-mini",
  "temperature": 0.7,
  "maxTokens": 2048
}
```

Provider options: `"anthropic"`, `"openai"`, `"ollama"`

For OpenAI-compatible providers (OpenRouter, Together, Groq):
```json
"llm": {
  "provider": "openai",
  "apiKey": "your-key",
  "baseUrl": "https://openrouter.ai/api/v1",
  "model": "meta-llama/llama-3.1-8b-instruct"
}
```

Restart after changing: `multis restart`

---

## 18. Operators & the Single-Owner Model

There is one **owner** — the first person to pair, set at setup. The owner is the only
privileged principal: only the owner can run host shell (`/exec`, `/read`), index from
a host path, set chat modes, or change the PIN. Everyone else is a **customer** and has
none of those commands.

There is **no second-tier "limited admin."** It was removed because it never fit how
multis actually runs:

- multis runs on **your** machine watching **your** Beeper inbox, so every Beeper chat
  is "you ↔ someone else." A third party has no independent channel to the bot — only
  their conversation *with you* — so there's no coherent chat to mark as "admin."
- A Telegram-only helper would be a half-operator: they'd get escalation pings but
  **couldn't see or take over a chat** (your conversations live in Beeper, not Telegram).
- A helper who genuinely needs to see and reply in chats needs the **Beeper account
  itself** — and Beeper is multi-device, so they just add a device (phone, second
  desktop). At that point they *are* the owner identity. **The owner is one identity
  that can span any number of trusted devices or people sharing the account** — nothing
  to "designate."

### What about the PIN, then?

The PIN can't separate operators who share one account: your note-to-self is synced
across devices, so any PIN is visible to everyone on the account. The PIN's real job is
a **speed bump on destructive actions** — anti-accident, anti-injection, anti-hijacked-
model — not access control. Benign actions run free; destructive ones ask for the PIN;
catastrophic ones are hard-blocked (see [§14](#14-pin-and-security)).

> If you ever need a genuinely restricted remote helper (reply-only, no host access),
> that's a future "relay-operator" feature, not the removed admin tier — ask if you hit
> the need.

---

## 19. Troubleshooting

### Bot not responding

1. Check if multis is running: `multis status`
2. If not running: `multis start`
3. Check logs: `cat ~/.multis/logs/daemon.log`
4. Run diagnostics: `multis doctor`

### Beeper not working

1. Is beeperbox running? (the Docker container, or `node mcp/server.js` in lite mode)
2. Can multis reach the MCP endpoint? `curl -X POST http://localhost:23375 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` should return JSON.
3. Does beeperbox see your account? The startup log shows `connected via beeperbox MCP … (N accounts)`. `0 accounts` means Beeper isn't logged in / bridges aren't linked inside beeperbox — fix that in beeperbox (its noVNC login or your local Beeper Desktop).
4. Wrong endpoint/token? Check `platforms.beeper.mcp_url` / `mcp_token` in `~/.multis/config.json`, or re-run `multis init` and redo the Beeper step.

### LLM errors

1. Check your API key in `~/.multis/config.json`
2. Test connectivity: `multis doctor`
3. For Ollama: ensure `ollama serve` is running and the model is downloaded

### "LLM not configured"

Set an API key. Either:
- Re-run `multis init` and complete the LLM step
- Edit `~/.multis/config.json` directly and add your API key
- Set environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`

### PIN issues

- **Forgot PIN:** Edit `~/.multis/config.json`, set `"pin_hash": null`, restart. Then set a new one with `/pin`.
- **Locked out:** Wait 60 minutes, or edit `~/.multis/auth/pin_sessions.json` to clear the lockout.

### Stale messages after restart

Telegram: messages older than 120 seconds are automatically dropped on startup.
Beeper: the poller seeds its "seen" set on startup, so old messages aren't reprocessed.

### Documents not being found

1. Check they're indexed: `/docs`
2. Check the scope: admin-scoped docs aren't visible to non-owner users
3. Try a direct search: `/search <keyword>`
4. Re-index if needed: `/index <path> public`

---

## 20. File Locations

| Path | Purpose |
|------|---------|
| `~/.multis/config.json` | Main configuration (platforms, LLM, security, business, memory) |
| `~/.multis/tools.json` | Tool definitions (enable/disable tools for the agent loop) |
| `~/.multis/auth/governance.json` | Shell command allowlist/denylist |
| `~/.multis/auth/beeper-token.json` | Beeper OAuth token |
| `~/.multis/auth/pin_sessions.json` | Active PIN sessions |
| `~/.multis/data/documents.db` | SQLite database (FTS5 index, chunks, ACT-R activation) |
| `~/.multis/data/memory/chats/` | Per-chat raw daily logs (durable memory + conversation thread live in `litectx.db`) |
| `~/.multis/logs/daemon.log` | Daemon stdout/stderr |
| `~/.multis/logs/audit.log` | Audit trail (all commands, pairings, escalations) |
| `~/.multis/run/multis.pid` | Daemon PID file |
