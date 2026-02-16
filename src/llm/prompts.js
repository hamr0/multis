/**
 * RAG prompt builder — formats search chunks into LLM prompts.
 */

const SYSTEM_PROMPT = `You are multis, a personal assistant running locally on the owner's machine. You have tools to directly execute actions — use them instead of suggesting commands.

When the user asks you to do something (play music, open a page, send a message, check something), USE THE APPROPRIATE TOOL to do it. Don't suggest commands — just do it.

You can:
- Execute shell commands, open URLs, control media, take screenshots
- Search indexed documents (cite as [filename, page X])
- Send notifications, manage clipboard, check system info
- On Android: make calls, send SMS, access contacts, use camera, TTS

You have persistent memory across conversations. The "Memory" section below (if present) contains durable notes from past conversations. You DO remember things — refer to your memory section when relevant.

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
