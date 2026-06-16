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
| `/forget` | Clear conversation memory |
| `/skills` | List available skills |
| `/unpair` | Remove pairing |
| `/help` | Show command list |

Plain text messages are treated as implicit `/ask`.

### Owner / Admin

The **owner** (super-admin, set at setup) can run everything below. A **limited admin** — a chat the owner designates with `/admin` — gets the staff commands (`/index`, `/mode`, `/ask`) but **not** host shell (`/exec`, `/read`), `/pin`, or `/admin` itself.

| Command | Who | Description |
|---------|-----|-------------|
| `/exec <cmd>` | Owner | Run a shell command (PIN protected) |
| `/read <path>` | Owner | Read a file or directory (PIN protected) |
| `/index <path> <kb\|admin>` | Admin | Index a document with scope (PIN protected) |
| `/pin` | Owner | Change or set PIN |
| `/admin` | Owner | Designate / list / remove limited admins (`/admin`, `/admin list`, `/admin remove <n>`) |
| `/mode <personal\|business\|silent> [agent]` | Admin | Set chat mode, optionally assign agent (PIN protected). `/mode business` (no target) opens business persona menu |
| `/agent [name]` | Owner | Show current agent (no args) or assign agent to this chat |
| `/agents` | Owner | List all configured agents |
| `/start <code>` | — | Pair with the bot using pairing code |
| Send a file | Admin | Auto-index uploaded documents (Telegram only) |
| `@agentname <message>` | Owner | Invoke a specific agent for one message |

### Chat Modes

| Mode | Behavior |
|------|----------|
| `personal` | Admin mode, all commands enabled |
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
