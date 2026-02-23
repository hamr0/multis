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
 * @param {Object} llm - LLM provider with generate() method
 * @param {import('../indexer/index').DocumentIndexer} indexer - Document indexer
 * @param {Object} options - { keepLast: 5 }
 */
async function runCapture(chatId, mem, llm, indexer, options = {}) {
  const keepLast = options.keepLast || 5;
  const role = options.role || options.scope || 'public';
  const maxSections = options.maxSections || 12;

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

    // Append to durable memory + index as FTS chunk (skip if nothing notable)
    if (summary && !summary.toLowerCase().includes('no notable information')) {
      mem.appendMemory(summary);

      // Index summary as a single searchable chunk
      const now = new Date().toISOString();
      try {
        indexer.store.saveChunk({
          chunkId: `mem-${chatId}-${Date.now()}`,
          filePath: `memory/chats/${chatId}`,
          pageStart: 0,
          pageEnd: 0,
          element: 'chat',
          name: `Memory capture ${now}`,
          content: summary,
          parentChunkId: null,
          sectionPath: [chatId],
          sectionLevel: 0,
          type: 'conv',
          metadata: { chatId },
          role,
          createdAt: now,
          updatedAt: now
        });
      } catch {
        // Store error — not critical
      }
    }

    // Prune memory.md to max sections
    mem.pruneMemory(maxSections);

    // Trim recent to keep last N messages
    mem.trimRecent(keepLast);

    console.log(`[capture] Chat ${chatId}: captured ${recent.length - keepLast} messages`);
  } catch (err) {
    console.error(`[capture] Error for chat ${chatId}: ${err.message}`);
  }
}

const CONDENSE_SYSTEM = `You are a memory condenser. Your job is to merge multiple conversation summaries into a single concise summary.

Rules:
- Combine related facts, remove duplicates
- Preserve names, dates, decisions, and action items
- Use concise bullet points
- Keep the most important and recent information
- If sections conflict, prefer the more recent one`;

/**
 * Stage 2: condense old memory.md sections into a single DB chunk.
 * Fires when memory.md has >= sectionCap sections.
 * Keeps the last keepRecent sections, condenses the rest into one DB chunk.
 * @param {string} chatId
 * @param {import('./manager').ChatMemoryManager} mem
 * @param {Object} llm - LLM provider with generate() method
 * @param {import('../indexer/index').DocumentIndexer} indexer
 * @param {Object} options - { sectionCap: 5, keepRecent: 3, role: 'public' }
 */
async function runCondenseMemory(chatId, mem, llm, indexer, options = {}) {
  const sectionCap = options.sectionCap || 5;
  const keepRecent = options.keepRecent || 3;
  const role = options.role || 'public';

  try {
    const sectionCount = mem.countMemorySections();
    if (sectionCount < sectionCap) return;

    const content = mem.loadMemory();
    // Split into sections (each starts with ## 2026- style header)
    const sections = content.split(/(?=\n## \d{4}-)/);
    // First section might not start with \n, handle leading content
    const cleaned = sections.map(s => s.trimStart()).filter(s => s.length > 0);

    if (cleaned.length < sectionCap) return;

    const toCondense = cleaned.slice(0, cleaned.length - keepRecent);
    const toKeep = cleaned.slice(-keepRecent);

    const condensedText = toCondense.join('\n\n');

    const summary = await llm.generate(
      `Condense these conversation summaries into one concise summary:\n\n${condensedText}`,
      { system: CONDENSE_SYSTEM, maxTokens: 512, temperature: 0.3 }
    );

    if (summary && !summary.toLowerCase().includes('no notable information')) {
      // Store condensed summary as a DB chunk
      const now = new Date().toISOString();
      try {
        indexer.store.saveChunk({
          chunkId: `condense-${chatId}-${Date.now()}`,
          filePath: `memory/chats/${chatId}`,
          pageStart: 0,
          pageEnd: 0,
          element: 'chat',
          name: `Memory condensation ${now}`,
          content: summary,
          parentChunkId: null,
          sectionPath: [chatId],
          sectionLevel: 0,
          type: 'conv',
          metadata: { chatId, condensed: true },
          role,
          createdAt: now,
          updatedAt: now
        });
      } catch {
        // Store error — not critical
      }
    }

    // Rewrite memory.md with only the recent sections
    const fs = require('fs');
    fs.writeFileSync(mem.memoryPath, toKeep.join('\n').trimStart());

    console.log(`[condense] Chat ${chatId}: condensed ${toCondense.length} sections → DB, kept ${toKeep.length}`);
  } catch (err) {
    console.error(`[condense] Error for chat ${chatId}: ${err.message}`);
  }
}

module.exports = { runCapture, runCondenseMemory };
