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
| `/mode <personal\|business\|silent\|off> [agent]` | Owner | Set chat mode, optionally assign agent. Turning a chat **off** requires the PIN; other modes run free. `/mode` (no target) lists your recent chats live from Beeper (~24) with their current modes; `/mode business` (no target) opens the business persona menu |
| `/agent [name]` | Owner | Show current agent (no args) or assign agent to this chat |
| `/agents` | Owner | List all configured agents |
| `/start <code>` | — | Pair with the bot using pairing code |
| Send a file | Owner | Auto-index uploaded documents (Telegram only) |
| `@agentname <message>` | Owner | Invoke a specific agent for one message |

### Chat Modes

| Mode | Behavior |
|------|----------|
| `personal` | Owner mode, all commands enabled |
| `business` | Auto-respond to customers, escalation rules apply |
| `silent` | Archive messages to memory, no bot output |

## CLI Commands

Run from terminal with `node bin/multis.js <command>` or `multis <command>` if installed globally.

| Command | Description |
|---------|-------------|
| `multis init` | Interactive setup wizard (platforms, LLM, PIN) |
| `multis start` | Start daemon in background |
| `multis stop` | Stop running daemon |
| `multis status` | Check if daemon is running |
| `multis doctor` | Run diagnostic checks (config, LLM, DB, agents) |
