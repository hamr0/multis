const { DocChunk } = require('./chunk');

/**
 * DocumentChunker - section-aware chunk splitting with overlap.
 * Ported from aurora_context_doc.chunker.DocumentChunker (Python).
 */
class DocumentChunker {
  constructor({ maxChunkSize = 2000, overlap = 200 } = {}) {
    this.maxChunkSize = maxChunkSize;
    this.overlap = overlap;
  }

  /**
   * Split a large chunk into smaller overlapping pieces at sentence boundaries.
   * @param {DocChunk} chunk
   * @returns {DocChunk[]}
   */
  splitLarge(chunk) {
    if (chunk.content.length <= this.maxChunkSize) {
      return [chunk];
    }

    const chunks = [];
    const content = chunk.content;
    let start = 0;
    let partNum = 0;

    while (start < content.length) {
      let end = Math.min(start + this.maxChunkSize, content.length);

      // Try to break at sentence boundary
      if (end < content.length) {
        for (const marker of ['. ', '! ', '? ', '\n\n', '\n']) {
          const lastBreak = content.lastIndexOf(marker, end);
          if (lastBreak > start) {
            end = lastBreak + marker.length;
            break;
          }
        }
      }

      const sliceContent = content.slice(start, end).trim();
      if (sliceContent) {
        chunks.push(new DocChunk({
          chunkId: `${chunk.chunkId}-p${partNum}`,
          filePath: chunk.filePath,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          element: chunk.element,
          name: `${chunk.name} (part ${partNum + 1})`,
          content: sliceContent,
          parentChunkId: chunk.parentChunkId,
          sectionPath: chunk.sectionPath,
          sectionLevel: chunk.sectionLevel,
          type: chunk.type,
          metadata: chunk.metadata,
          createdAt: chunk.createdAt,
          updatedAt: chunk.updatedAt
        }));
      }

      if (end >= content.length) break;

      // Move forward with overlap, ensure progress
      const nextStart = end - this.overlap;
      start = nextStart <= start ? start + 1 : nextStart;
      partNum++;
    }

    return chunks;
  }

  /**
   * Process an array of chunks: split large ones.
   * @param {DocChunk[]} chunks
   * @returns {DocChunk[]}
   */
  process(chunks) {
    const result = [];
    for (const chunk of chunks) {
      result.push(...this.splitLarge(chunk));
    }
    return result;
  }
}

module.exports = { DocumentChunker };
