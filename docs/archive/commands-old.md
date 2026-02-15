# Bot Command Reference

## Telegram Commands (prefix: `/`)

| Command | Access | Description |
|---------|--------|-------------|
| `/start <code>` | Anyone | Pair with bot using pairing code |
| `/status` | Paired | Bot info (version, role, LLM provider) |
| `/ask <question>` | Paired | Ask about indexed documents (RAG) |
| `/search <query>` | Paired | Search indexed documents (raw chunks) |
| `/docs` | Paired | Show indexing stats |
| `/skills` | Paired | List available skills |
| `/unpair` | Paired | Remove your pairing |
| `/help` | Paired | Show command list |
| `/exec <cmd>` | Owner | Run a shell command |
| `/read <path>` | Owner | Read a file or directory |
| `/index <path>` | Owner | Index a document |
| *plain text* | Paired | Treated as implicit `/ask` |
| *file upload* | Owner | Index the uploaded file |

## Beeper Commands (prefix: `//`)

| Command | Access | Description |
|---------|--------|-------------|
| `//start <code>` | Self | Pair (if needed) |
| `//ask <question>` | Self | Ask about indexed documents |
| `//mode <personal\|business>` | Self | Set chat mode |
| `//search <query>` | Self | Search indexed documents |
| `//status` | Self | Bot info |
| `//help` | Self | Show command list |
| `//exec <cmd>` | Self (owner) | Run a shell command |
| `//read <path>` | Self (owner) | Read a file or directory |
| `//index <path>` | Self (owner) | Index a document |
| *plain text in personal chat* | Self | Implicit ask |

## Access Levels

- **Anyone**: No pairing required
- **Paired**: Must have sent `/start <code>` with valid pairing code
- **Owner**: First paired user, has elevated privileges
- **Self**: Beeper self-messages only (you sending to yourself)
