const crypto = require('crypto');

/**
 * DocChunk - represents a document section/chunk.
 * Ported from aurora_core.chunks.DocChunk (Python dataclass).
 */
class DocChunk {
  constructor({
    chunkId = null,
    filePath,
    pageStart = 0,
    pageEnd = 0,
    elementType = 'paragraph',  // toc_entry, section, paragraph, table
    name = '',
    content = '',
    parentChunkId = null,
    sectionPath = [],           // breadcrumb array: ["Chapter 1", "Section 1.2"]
    sectionLevel = 0,           // heading depth 1-5, 0 = body
    documentType = 'unknown',   // pdf, docx, md, txt
    metadata = {},
    scope = 'kb',               // kb, admin, user:<chatId>
    createdAt = null,
    updatedAt = null
  }) {
    this.chunkId = chunkId || DocChunk.generateId(filePath, name, content);
    this.filePath = filePath;
    this.pageStart = pageStart;
    this.pageEnd = pageEnd;
    this.elementType = elementType;
    this.name = name;
    this.content = content;
    this.parentChunkId = parentChunkId;
    this.sectionPath = sectionPath;
    this.sectionLevel = sectionLevel;
    this.documentType = documentType;
    this.metadata = metadata;
    this.scope = scope;
    this.createdAt = createdAt || new Date().toISOString();
    this.updatedAt = updatedAt || new Date().toISOString();
  }

  static generateId(filePath, name, content) {
    const hash = crypto.createHash('sha256')
      .update(`${filePath}:${name}:${content.slice(0, 200)}`)
      .digest('hex')
      .slice(0, 16);
    return `doc:${hash}`;
  }

  toJSON() {
    return {
      chunk_id: this.chunkId,
      file_path: this.filePath,
      page_start: this.pageStart,
      page_end: this.pageEnd,
      element_type: this.elementType,
      name: this.name,
      content: this.content,
      parent_chunk_id: this.parentChunkId,
      section_path: this.sectionPath,
      section_level: this.sectionLevel,
      document_type: this.documentType,
      metadata: this.metadata,
      scope: this.scope,
      created_at: this.createdAt,
      updated_at: this.updatedAt
    };
  }
}

module.exports = { DocChunk };
