# Insights

## Aurora porting: adapt, don't translate
Aurora's Python code (PyMuPDF, python-docx, tree-sitter) doesn't translate line-for-line to Node.js. The approach worked: understand the *concept* (hierarchical chunking, FTS5, ACT-R columns), then implement idiomatically in Node.js with different libraries (pdf-parse, mammoth).

## Beeper's E2EE is a dead end for bots
Spent a full day on Beeper Matrix integration. The platform actively prevents third-party clients from reading bridge messages. Self-messages decrypt fine, but bridges withhold keys. The localhost Desktop API is the escape hatch — simple polling, no crypto, token auth.

## FTS5 > custom BM25
Aurora implemented its own BM25 scorer in Python. SQLite's FTS5 has built-in BM25 ranking that's faster and simpler. No need to port the scorer — just use `ORDER BY rank` on FTS5 queries.

## Platform abstraction pays off early
Adding the Message class and Platform base class (POC7 partial) made POC4 easier. The router doesn't care if a message came from Telegram or Beeper. Worth doing early even if only two platforms exist.

## Chat modes solve the "all chats" problem
Beeper gives you every chat across every network. Without modes, you'd either auto-respond to everyone (chaos) or never respond (useless). Per-chat modes let users opt individual chats into bot interaction.
