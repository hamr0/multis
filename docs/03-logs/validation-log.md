# Validation Log

## POC1: Telegram Echo Bot
- [x] Bot connects to Telegram
- [x] `/start <code>` pairs user
- [x] Deep link `t.me/multis02bot?start=<code>` works
- [x] Text message → `Echo: <text>` reply
- [x] Unpaired user → rejection message

## POC2: Basic Skills
- [x] `/exec ls` → output returned
- [x] `/exec rm -rf /` → denied by governance
- [x] `/read ~/Documents/file.txt` → file contents
- [x] Audit log populated in `~/.multis/audit.log`
- [x] Non-owner user → "Owner only command"

## POC3: Document Indexing
- [x] `/index ~/path/to/file.pdf` → "Indexed N chunks"
- [x] Telegram file upload → download + index
- [x] `/search <query>` → ranked chunk results
- [x] `/docs` → shows index stats
- [x] FTS5 query tokenization handles multi-word queries

## POC4: LLM RAG + Chat Modes
- [ ] `//ask what is X` in Beeper → LLM answers with doc citations
- [ ] Plain text in Beeper Note to Self → implicit ask
- [ ] `//mode business` → confirms toggle
- [ ] Someone messages a business chat → bot auto-responds
- [ ] `//mode personal` → reverts, incoming messages ignored
- [ ] Telegram plain text → LLM answer (not echo)
- [ ] No API key → clear error message
- [ ] No indexed docs → "No matching documents found"

## POC7 (partial): Platform Abstraction
- [x] Beeper Desktop API connection
- [x] Self-message detection
- [x] `//` command prefix parsing
- [x] Token auth + setup wizard
