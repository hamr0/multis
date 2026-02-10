/**
 * Memory capture orchestrator — summarizes conversation when rolling window overflows.
 * Runs fire-and-forget after responding (recent.json + daily log preserve raw data).
 */

const CAPTURE_SYSTEM = `You are a memory capture assistant. Your job is to extract durable, useful notes from a conversation.

Rules:
- Extract facts, preferences, decisions, and action items
- Use concise bullet points
- Include names, dates, and specific details
- Skip greetings, small talk, and meta-conversation
- If nothing noteworthy, respond with "No notable information."
- Do NOT repeat information that already exists in the memory section below`;

/**
 * Run memory capture: summarize recent messages and store as durable notes.
 * @param {string} chatId - Chat identifier
 * @param {import('./manager').ChatMemoryManager} mem - Memory manager instance
 * @param {import('../llm/base').LLMProvider} llm - LLM provider
 * @param {import('../indexer/index').DocumentIndexer} indexer - Document indexer
 * @param {Object} options - { keepLast: 5 }
 */
async function runCapture(chatId, mem, llm, indexer, options = {}) {
  const keepLast = options.keepLast || 5;

  try {
    const recent = mem.loadRecent();
    if (recent.length === 0) return;

    const existingMemory = mem.loadMemory();

    // Format conversation for LLM
    const conversationText = recent
      .map(m => `[${m.role}]: ${m.content}`)
      .join('\n');

    const system = existingMemory.trim()
      ? `${CAPTURE_SYSTEM}\n\n## Existing memory\n${existingMemory}`
      : CAPTURE_SYSTEM;

    const summary = await llm.generate(
      `Summarize the notable information from this conversation:\n\n${conversationText}`,
      { system, maxTokens: 512, temperature: 0.3 }
    );

    // Append to durable memory (skip if nothing notable)
    if (summary && !summary.toLowerCase().includes('no notable information')) {
      mem.appendMemory(summary);
    }

    // Index raw messages as conversation chunks
    for (const m of recent.slice(0, -keepLast)) {
      try {
        indexer.store.saveChunk({
          chunk_id: `conv-${chatId}-${m.timestamp}`,
          file_path: `memory/chats/${chatId}`,
          page_start: null,
          page_end: null,
          element_type: 'conversation',
          name: `${m.role} @ ${m.timestamp}`,
          content: m.content,
          parent_chunk_id: null,
          section_path: JSON.stringify([chatId, m.role]),
          section_level: 0,
          document_type: 'conversation',
          metadata: JSON.stringify({ role: m.role, chatId }),
          created_at: m.timestamp,
          updated_at: m.timestamp
        });
      } catch {
        // Duplicate chunk_id or store error — not critical
      }
    }

    // Trim recent to keep last N messages
    mem.trimRecent(keepLast);

    console.log(`[capture] Chat ${chatId}: captured ${recent.length - keepLast} messages`);
  } catch (err) {
    console.error(`[capture] Error for chat ${chatId}: ${err.message}`);
  }
}

module.exports = { runCapture };
