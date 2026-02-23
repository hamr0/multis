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
18. [Adding a Second Admin](#18-adding-a-second-admin)
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

Beeper Desktop must be:
- Installed and logged in
- Running with the **Developer API enabled** (Settings > Developers > toggle on)
- Open whenever you want multis to respond to messages

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

### Step 1: Choose Your Mode

```
What do you need?
  1. Personal assistant (Telegram only)
  2. Personal assistant (Beeper) — recommended
  3. Business chatbot (Beeper) — with optional Telegram admin channel
```

- **Option 1** sets up Telegram only. Simple, works anywhere.
- **Option 2** connects Beeper, giving you access to WhatsApp, Signal, and other bridges through a single bot.
- **Option 3** enables business mode where the bot auto-responds to customer messages on Beeper, while you manage it from Telegram.

### Step 2: Connect Platforms

**Telegram:**
1. Open Telegram, search for `@BotFather`
2. Send `/newbot`, pick a name and username
3. Copy the bot token (looks like `123456:ABC-DEF...`)
4. Paste it into the wizard
5. The wizard verifies the token, then waits up to 60 seconds for you to open the bot in Telegram and send `/start` to pair as owner

**Beeper:**
1. Open Beeper Desktop
2. Go to Settings > Developers > enable the API toggle
3. The wizard detects Beeper on `localhost:23373`
4. A browser window opens for authorization
5. Approve access and the wizard saves your token
6. Your connected accounts (WhatsApp, Signal, etc.) are listed for confirmation

### Step 3: Choose an LLM Provider

| Provider | Cost | Notes |
|----------|------|-------|
| **Anthropic (Claude)** | Paid API | Default: `claude-haiku-4-5-20251001`. Fast and capable. |
| **OpenAI (GPT)** | Paid API | Default: `gpt-4o-mini`. Also works with OpenRouter, Together, Groq via custom base URL. |
| **Ollama** | Free (local) | Default: `llama3.1:8b`. No data leaves your machine. Requires Ollama installed. |

The wizard verifies connectivity by sending a test message before proceeding.

### Step 4: Set a PIN

Optionally set a 4-6 digit PIN to protect sensitive commands (`/exec`, `/read`, `/index`). The PIN is hashed and stored locally. You can skip this and set one later with `/pin`.

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

Changes made via bot commands (`/business setup`, `/mode`, `/agent`, `/pin`) are applied immediately — no restart needed.

---

## 6. Platforms

### Telegram

**How it works:** multis uses the Telegram Bot API via long polling. Your bot receives messages in real time as long as multis is running.

**Pairing:** The first person to send `/start <pairing_code>` becomes the owner. The pairing code is printed when multis starts. Additional users can pair with the same code.

**Commands:** All commands use the `/` prefix (`/ask`, `/exec`, `/help`, etc.). Plain text messages are treated as questions.

**File uploads:** Drag and drop a PDF, DOCX, MD, or TXT file into the chat to index it.

**If multis was offline:** Telegram queues messages for ~24 hours. When multis restarts, old messages (>120 seconds) are silently dropped to avoid a flood of stale responses.

### Beeper

**How it works:** multis polls the Beeper Desktop API on `localhost:23373` every 3 seconds. This gives you access to all your Beeper-bridged chats (WhatsApp, Signal, Instagram, etc.) through one bot.

**Requirements:**
- Beeper Desktop must be open and logged in
- Developer API must be enabled (Settings > Developers)
- Your computer must be awake and connected

**Commands:** Use the `/` prefix in your personal (Note to Self) chat. Commands are only accepted from messages you send yourself — not from contacts.

**Business mode:** In chats set to business mode, incoming messages from contacts trigger automatic LLM responses. Your self-sent messages in those chats are treated as commands.

**File uploads:** Send a document in Beeper. The bot asks for the scope (public/admin/skip) before indexing.

### Using Both Together

The recommended setup for business use:
- **Telegram** as your admin channel — manage the bot, run commands, monitor escalations
- **Beeper** as the customer-facing channel — customers message via WhatsApp/Signal/etc., the bot auto-responds

Set this up with `multis init` option 3 (Business chatbot).

---

## 7. Commands Reference

### Everyone Commands

| Command | Description |
|---------|-------------|
| `/ask <question>` | Ask a question (searches your documents, then asks the LLM) |
| `/search <query>` | Search indexed documents (no LLM, just FTS5 results) |
| `/docs` | Show how many documents and chunks are indexed |
| `/status` | Bot version, platform, your role, LLM provider |
| `/memory` | Show saved memory notes for this chat |
| `/remember <note>` | Save a note to this chat's memory |
| `/forget` | Clear all memory for this chat |
| `/skills` | List available skills |
| `/unpair` | Remove your pairing (you'll need the code to pair again) |
| `/help` | Show available commands |
| *(plain text)* | Treated as `/ask <your text>` |

### Owner-Only Commands

| Command | Description |
|---------|-------------|
| `/exec <command>` | Run a shell command on your machine (PIN required) |
| `/read <path>` | Read a file or list a directory (PIN required) |
| `/index <path> <public\|admin>` | Index a document or directory (PIN required) |
| `/pin` | Change or set your PIN |
| `/mode [mode] [target]` | View or set chat modes (business/silent/off) |
| `/agent [name]` | View or assign an agent to this chat |
| `/agents` | List all configured agents |
| `/remind <duration> <action>` | Set a one-shot reminder (e.g. `/remind 30m call dentist`) |
| `/cron <expr> <action>` | Set a recurring task (e.g. `/cron 0 9 * * 1-5 morning briefing`) |
| `/jobs` | List all active reminders and cron jobs |
| `/cancel <job-id>` | Cancel a scheduled job |
| `/plan <goal>` | Break a goal into steps and execute them |
| `/business setup\|show\|clear` | Configure the business persona |
| `@agentname <message>` | Route one message to a specific agent |

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

The bot archives all messages and periodically summarizes them for later search. No responses. Useful for chats you want to monitor without the bot interfering.

### Off Mode

The bot completely ignores messages in this chat. No archiving, no logs, no memory, no responses.

### Setting Modes Per Chat

```
/mode                           # Show current modes for all chats
/mode business                  # Set current chat to business mode
/mode silent John               # Set John's chat to silent (searches by name)
/mode off "WhatsApp Group"      # Set a specific chat to off
```

From Telegram (admin channel), you can manage Beeper chat modes remotely:

```
/mode business Acme Corp        # Set Acme Corp's Beeper chat to business
/mode silent                    # Set Telegram chat to silent (global)
```

---

## 9. Business Persona Setup

Configure how the bot represents your business to customers.

### Using the Wizard

```
/business setup
```

The wizard walks through:

1. **Business name** — e.g. "Acme Support" (2-100 characters)
2. **Greeting** — what the bot says first, e.g. "Welcome to Acme! How can I help?" (max 500 chars, or skip)
3. **Topics** — what the bot can help with. Add topics one by one with optional descriptions (max 200 chars each):
   - "Pricing" → "Plans, billing, and payment info"
   - "Returns" → "Return policy and refund process"
   - Send "done" when finished
4. **Rules** — custom instructions (max 200 chars each), e.g. "Always respond in Spanish", "Never offer discounts" (send "done" when finished)
5. **Admin chat** — which chat should receive escalation notifications. Paste a chat ID, or "skip" to configure later
6. **Confirm** — review the summary, type "yes" to save

Type "cancel" at any step to abort. Any `/command` typed during the wizard cancels it and routes the command normally.

### Viewing and Clearing

```
/business show     # Display current business persona
/business clear    # Reset to blank
```

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

**Max file size:** 10 MB

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
| `admin` | Owner only | Private notes, internal docs, sensitive info |

Customer messages in business mode only search `public` documents. The owner always searches everything.

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
/remember Customer prefers email over phone    # Save a note
/memory                                        # View saved notes
/forget                                        # Clear all notes
```

### Automatic Memory

When a conversation reaches 10 messages (configurable), multis automatically:
1. Summarizes the conversation using the LLM
2. Saves the summary to the chat's `memory.md`
3. Indexes the summary for future search
4. Trims the rolling window to keep the 5 most recent messages
5. Older summaries are periodically condensed into long-term searchable chunks

This means the bot remembers key facts from past conversations without you manually saving them.

### Memory Scope

- **Admin memory** is shared across all platforms (Telegram + Beeper personal chats use the same `admin/memory.md`)
- **Customer memory** is per-chat (each Beeper contact has their own memory)

---

## 13. Agents

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

### PIN-Protected Commands

These commands require PIN authentication:
- `/exec` — run shell commands
- `/read` — read files
- `/index` — index documents

When you send a protected command, the bot asks for your PIN. After entering the correct PIN, your session is active for 24 hours (configurable).

### Changing Your PIN

```
/pin
```

If a PIN is set, you'll be asked to enter your current PIN first, then the new one. If no PIN is set, you go straight to setting a new one.

### Lockout

After 3 wrong PIN attempts, your account is locked for 60 minutes. The bot tells you when the lockout expires.

### Governance

Shell commands (`/exec`) are filtered through a governance system:
- **Allowlist:** Safe commands like `ls`, `cat`, `grep`, `git`, `python`
- **Denylist:** Dangerous commands like `rm`, `sudo`, `chmod`, `shutdown`
- **Confirmation required:** Risky but useful commands like `mv`, `cp`, `git push`
- **Path restrictions:** Only allowed directories (like `~/Documents`) can be accessed

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
| **Android** (spare phone + Termux) | $0 | Runs Node.js. Bonus: SMS, calls, camera via termux-api. Must stay on and charged. |
| **Laptop** | $0 | Works but sleeps. Fine for daytime use. |

**Business use (Beeper bridges — WhatsApp, Signal, etc.):**

| Device | Cost | Works? |
|--------|------|--------|
| **Raspberry Pi** | $35-60 one-time | Best option. Runs Beeper Desktop + multis. Silent, low power, always on. |
| **Laptop / mini PC** | $0-80 | Works but must stay open and awake. |
| **VPS** | $10-20/year | No — Beeper Desktop needs a display. No headless mode. |
| **Android** | $0 | No — Beeper mobile doesn't expose the Desktop API (localhost:23373). |

**Why can't Beeper run on a VPS?** Beeper Desktop is an Electron app (GUI). It needs a display to run. While you could hack around this with a virtual display (Xvfb), it's fragile and unsupported. Beeper's cloud connections sync your chats across their app — they don't expose an API for third-party bots.

**Bottom line:** For business mode with Beeper bridges, the Raspberry Pi is the cheapest and most reliable always-on option.

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

#### Step 3: Install Beeper Desktop

Beeper provides an ARM64 AppImage for Linux:

```bash
# Download the ARM64 AppImage
curl -L -o ~/Beeper.AppImage \
  "https://api.beeper.com/desktop/download/linux/arm64/stable/com.automattic.beeper.desktop"

# Make it executable
chmod +x ~/Beeper.AppImage

# Install FUSE (required for AppImages)
sudo apt-get install -y fuse libfuse2
```

Launch Beeper:

```bash
~/Beeper.AppImage
```

1. Sign in to your Beeper account
2. Connect your messaging accounts (WhatsApp, Signal, etc.) through the Beeper UI
3. Go to **Settings > Developers** and enable the **Desktop API** toggle
4. Keep Beeper running

#### Step 4: Install and configure multis

```bash
# Install multis
npm install -g multis

# Run the setup wizard
multis init
```

The wizard will detect Beeper on `localhost:23373` and walk you through connecting Telegram, choosing an LLM provider, and setting a PIN.

#### Step 5: Start multis and auto-start on boot

```bash
# Start the daemon
multis start

# Verify it's running
multis status
```

To auto-start multis and Beeper on boot, create a systemd user service:

```bash
mkdir -p ~/.config/systemd/user

# Beeper auto-start
cat > ~/.config/systemd/user/beeper.service << 'EOF'
[Unit]
Description=Beeper Desktop
After=graphical-session.target

[Service]
ExecStart=/home/pi/Beeper.AppImage
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

# multis auto-start (after Beeper)
cat > ~/.config/systemd/user/multis.service << 'EOF'
[Unit]
Description=multis AI assistant
After=beeper.service
Wants=beeper.service

[Service]
ExecStart=/usr/bin/node /usr/lib/node_modules/multis/src/index.js
Restart=on-failure
RestartSec=10
Environment=HOME=/home/pi

[Install]
WantedBy=default.target
EOF

# Enable both
systemctl --user enable beeper multis
systemctl --user start beeper multis

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

The Pi sits on your network, always on, running Beeper + multis. Customers message on WhatsApp, the bot responds automatically.

### VPS Setup

For Telegram-only (personal use), a cheap VPS works perfectly.

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

# Setup (choose Telegram only, no Beeper)
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

## 18. Adding a Second Admin

Currently, multis has a single owner model — the first person to pair becomes the owner. Other paired users can use basic commands (`/ask`, `/search`, `/memory`) but not owner commands.

To pair a second user:

1. Run `multis status` or check the startup logs for the pairing code
2. Have the user send `/start <pairing_code>` to the bot on Telegram
3. They'll be paired as a regular user (not owner)

To make someone the owner, edit `~/.multis/config.json` and set `owner_id` to their user ID, then restart.

**Note:** There can only be one owner. Owner-only commands (`/exec`, `/read`, `/index`, `/mode`, `/business`, `/pin`, etc.) are restricted to the owner.

---

## 19. Troubleshooting

### Bot not responding

1. Check if multis is running: `multis status`
2. If not running: `multis start`
3. Check logs: `cat ~/.multis/logs/daemon.log`
4. Run diagnostics: `multis doctor`

### Beeper not working

1. Is Beeper Desktop open? It must be running.
2. Is the Developer API enabled? Settings > Developers > toggle on
3. Can you reach it? `curl http://localhost:23373/v1/spec` should return JSON
4. Re-authorize: `multis init` and redo the Beeper step

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
| `~/.multis/data/memory/chats/` | Per-chat memory files (recent.json, memory.md, daily logs) |
| `~/.multis/logs/daemon.log` | Daemon stdout/stderr |
| `~/.multis/logs/audit.log` | Audit trail (all commands, pairings, escalations) |
| `~/.multis/run/multis.pid` | Daemon PID file |
