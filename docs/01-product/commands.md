# multis Commands Reference

## Chat Commands

Commands are sent via chat. Telegram uses `/` prefix, Beeper uses `//`.

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

### Owner Only

| Command | Description |
|---------|-------------|
| `/exec <cmd>` | Run a shell command (PIN protected) |
| `/read <path>` | Read a file or directory (PIN protected) |
| `/index <path> <kb\|admin>` | Index a document with scope (PIN protected) |
| `/pin` | Change or set PIN |
| `/mode <personal\|business\|silent> [agent]` | Set chat mode, optionally assign agent (PIN protected) |
| `/agent [name]` | Show current agent (no args) or assign agent to this chat |
| `/agents` | List all configured agents |
| `/start <code>` | Pair with the bot using pairing code |
| Send a file | Auto-index uploaded documents (Telegram only) |
| `@agentname <message>` | Invoke a specific agent for one message |

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
