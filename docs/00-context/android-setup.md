# Android Setup (Termux)

Run multis on your Android phone as a self-hosted personal assistant via Telegram.

## Prerequisites

1. **Install Termux** from [F-Droid](https://f-droid.org/en/packages/com.termux/)
   - Do NOT use the Play Store version — it's outdated and broken
   - Optional: also install **Termux:Boot** (for auto-start on reboot) and **Termux:API** (for phone integration)

2. **Open Termux** and allow any permission prompts

## Install

Paste this single command into Termux:

```
curl -sL https://raw.githubusercontent.com/hamr0/multis/main/scripts/setup-termux.sh | bash
```

The script handles everything:
- Installs Node.js, git, and build tools
- Clones the multis repo
- Installs and compiles dependencies (including SQLite for ARM)
- Runs the setup wizard (Telegram bot token + LLM API key)
- Optionally sets up auto-start on boot

## What you need ready

- **Telegram bot token** — create one via [@BotFather](https://t.me/BotFather) on Telegram (`/newbot`)
- **LLM API key** — from Anthropic, OpenAI, or use Ollama (free/local)

## After setup

```bash
cd ~/multis
termux-wake-lock       # prevent Android from killing Termux
npx multis start       # start the bot
```

## Keep it running

Android aggressively kills background apps. To prevent this:

1. **Wake lock**: run `termux-wake-lock` before starting multis
2. **Battery optimization**: Settings > Apps > Termux > Battery > Unrestricted
3. **Auto-start on boot**: install Termux:Boot from F-Droid (the setup script configures this)

## Limitations on Android

- **Telegram only** — Beeper Desktop API requires a desktop computer
- **No PDF indexing** — `pdfjs-dist` may not load (canvas dependency); all other features work
- **Performance** — compiling SQLite takes 1-2 minutes on a phone (one-time)

## Updating

```bash
cd ~/multis
git pull
npm install --ignore-scripts --legacy-peer-deps
npx node-gyp rebuild --directory=node_modules/better-sqlite3 --nodedir=/data/data/com.termux/files/usr
npx multis restart
```

Or re-run the setup script — it detects existing installs and updates:

```
bash ~/multis/scripts/setup-termux.sh
```
