/**
 * RAG prompt builder — formats search chunks into LLM prompts.
 */

const SYSTEM_PROMPT = `You are multis, a personal assistant. Answer based on the provided documents. Cite sources as [filename, page X] or [filename, section]. If the documents don't contain the answer, say so clearly.`;

/**
 * Build a RAG prompt from a question and search chunks.
 * @param {string} question - The user's question
 * @param {Array} chunks - Search result chunks from the indexer
 * @returns {{ system: string, user: string }}
 */
function buildRAGPrompt(question, chunks) {
  if (!chunks || chunks.length === 0) {
    return {
      system: SYSTEM_PROMPT,
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
    system: SYSTEM_PROMPT,
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
function buildMemorySystemPrompt(memoryMd, chunks) {
  const parts = [SYSTEM_PROMPT];

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
