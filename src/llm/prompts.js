/**
 * RAG prompt builder — formats search chunks into LLM prompts.
 */

const SYSTEM_PROMPT = `You are multis, a personal assistant running locally on the owner's machine. You have tools to directly execute actions — use them instead of suggesting commands.

When the user asks you to do something, USE THE APPROPRIATE TOOL to do it. Don't suggest commands — just do it.

CRITICAL: You can ONLY do things your tools support. Your tools are listed in this conversation — if a capability is not covered by any tool, you CANNOT do it. Never claim to have done something you have no tool for. Specifically, you CANNOT:
- Set alarms (but you CAN suggest the user use /remind for reminders)
- Send emails
- Make purchases or payments
- Access the internet or browse websites (you can only open URLs in the user's browser)
If the user asks for something you can't do, say so honestly and suggest an alternative if possible (e.g. "I can't set reminders, but I can save a note to memory so I'll mention it next time we talk").

You have persistent memory across conversations. The "Memory" section below (if present) contains durable notes from past conversations. You DO remember things — refer to your memory section when relevant.
For older memories not shown above, use the recall_memory tool to search past conversation summaries.

If asked about documents and the context has relevant chunks, cite sources. If no documents match, say so.
Be direct and concise. Act first, explain after.`;

/**
 * Build a RAG prompt from a question and search chunks.
 * @param {string} question - The user's question
 * @param {Array} chunks - Search result chunks from the indexer
 * @returns {{ system: string, user: string }}
 */
function buildRAGPrompt(question, chunks, persona) {
  const base = persona || SYSTEM_PROMPT;
  if (!chunks || chunks.length === 0) {
    return {
      system: base,
      user: `No matching documents found.\n\nQuestion: ${question}`
    };
  }

  const formattedChunks = chunks.map((chunk, i) => {
    const source = chunk.name || 'unknown';
    const section = chunk.sectionPath?.join(' > ') || '';
    const pages = chunk.pageStart != null
      ? chunk.pageEnd && chunk.pageEnd !== chunk.pageStart
        ? `pages ${chunk.pageStart}-${chunk.pageEnd}`
        : `page ${chunk.pageStart}`
      : '';
    const meta = [source, section, pages].filter(Boolean).join(', ');
    return `--- Document ${i + 1} [${meta}] ---\n${chunk.content}`;
  });

  return {
    system: base,
    user: `${formattedChunks.join('\n\n')}\n\n---\nQuestion: ${question}`
  };
}

/**
 * Build a system prompt that includes durable memory and optional RAG chunks.
 * Used by the memory-aware conversation flow.
 * @param {string} memoryMd - Contents of memory.md (durable notes)
 * @param {Array} chunks - Optional RAG search chunks
 * @returns {string} - Combined system prompt
 */
function buildMemorySystemPrompt(memoryMd, chunks, persona) {
  const parts = [persona || SYSTEM_PROMPT];

  if (memoryMd && memoryMd.trim()) {
    parts.push(`\n## Memory (durable notes about this conversation)\n${memoryMd.trim()}`);
  }

  if (chunks && chunks.length > 0) {
    const formattedChunks = chunks.map((chunk, i) => {
      const source = chunk.name || 'unknown';
      const section = chunk.sectionPath?.join(' > ') || '';
      const pages = chunk.pageStart != null
        ? chunk.pageEnd && chunk.pageEnd !== chunk.pageStart
          ? `pages ${chunk.pageStart}-${chunk.pageEnd}`
          : `page ${chunk.pageStart}`
        : '';
      const meta = [source, section, pages].filter(Boolean).join(', ');
      return `--- Document ${i + 1} [${meta}] ---\n${chunk.content}`;
    });
    parts.push(`\n## Relevant documents\n${formattedChunks.join('\n\n')}`);
  }

  return parts.join('\n');
}

module.exports = { buildRAGPrompt, buildMemorySystemPrompt };
