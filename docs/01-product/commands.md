# multis Commands Reference

## Chat Commands

Commands are sent via chat with a `/` prefix on every platform (Telegram and Beeper alike). On Beeper, commands only work from your personal / Note-to-self chats.

### Everyone

| Command | Description |
|---------|-------------|
| `/ask <question>` | Ask about indexed documents |
| `/search <query>` | Search indexed documents |
| `/docs` | Show indexing stats |
| `/status` | Bot info (version, role, provider) |
| `/memory` | Show conversation memory for this chat |
| `/remember <note>` | Save a note to memory |
| `/forget <topic>` | Remove specific matching notes (pick if several); `/forget all` clears the chat — PIN protected (destructive) |
| `/skills` | List available skills |
| `/help` | Show commands, grouped by intent (Ask / Remember / Schedule / Run / Manage) and filtered to your role; `/help <command>` for one command's details |

Plain text messages are treated as implicit `/ask`.

### Owner

The **owner** (set at setup) runs everything below. The owner is one identity that
can span any number of trusted devices/people sharing the Beeper account; everyone
else is a customer and is never a privileged principal.

| Command | Who | Description |
|---------|-----|-------------|
| `/exec <cmd>` | Owner | Run a shell command — by severity: benign runs free, destructive → PIN, catastrophic (`rm -rf /`, `dd`, `mkfs`, …) → hard-blocked (never runs through the bot) |
| `/read <path>` | Owner | Read a file or directory (benign — owner-floor, no PIN) |
| `/index <path> <kb\|admin>` | Owner | Index a document with scope (benign — owner-floor, no PIN) |
| `/pin` | Owner | Change or set PIN |
| `/mode <mode> [chat name]` | Owner | Set a chat's engagement rung. The modes you can set depend on your **account type** — a personal-assistant account uses `personal`/`silent`/`off`, a business account `business`/`silent`/`off`; a per-chat `/mode` only steps down to silent/off or back to the account default (it can't cross streams). Turning a chat **off** requires the PIN; other modes run free. `/mode` (no target) lists your recent chats live from Beeper (~24) with their current modes; `/mode business` (no target) opens the business persona menu. On Telegram (personal-bot) `/mode` only reports the account type — to change it, run `multis init`. |
| `/name [new name]` | Owner | View or set the assistant's name (default `multis`). It's the personal-mode trigger word (in `personal` mode the bot replies only when this name is called) and the `[Name]` disclosure prefix on replies to contacts; it's also how the bot identifies itself when asked. Bare `/name` shows the current name. |
| `/agent [name]` | Owner | Show current agent (no args) or assign agent to this chat |
| `/agents` | Owner | List all configured agents |
| `/start <code>` | — | Pair with the bot using pairing code |
| Send a file | Owner | Auto-index uploaded documents (Telegram only) |
| `@agentname <message>` | Owner | Invoke a specific agent for one message |

### Chat Modes

One axis — how much the bot participates in a chat — most → least. Your account type owns the *engaged* rung (personal-assistant → `personal`, business → `business`); a per-chat `/mode` only steps down to `silent`/`off` or back to that default.

| Mode | Behavior |
|------|----------|
| `business` | Auto-respond to everyone; escalation rules apply |
| `personal` | Respond only when the assistant is called by name (see `/name`); otherwise capture silently |
| `silent` | Capture messages to memory, no bot output |
| `off` | Excluded entirely — no capture, no response (setting a chat off requires the PIN) |

## CLI Commands

Run from terminal with `node bin/multis.js <command>` or `multis <command>` if installed globally.

| Command | Description |
|---------|-------------|
| `multis init` | Interactive setup wizard (platforms, LLM, PIN) |
| `multis start` | Start daemon in background |
| `multis stop` | Stop running daemon |
| `multis status` | Check if daemon is running |
| `multis doctor` | Run diagnostic checks (config, LLM, DB, agents) |
