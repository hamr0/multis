const fs = require('fs');
const path = require('path');
const { getParser } = require('./parsers');
const { DocumentChunker } = require('./chunker');
const { DocumentStore } = require('./store');
const { logAudit } = require('../governance/audit');

/**
 * DocumentIndexer - orchestrates parsing, chunking, and storage.
 * Ported from aurora_context_doc.indexer.DocumentIndexer (Python).
 */
class DocumentIndexer {
  constructor(store = null) {
    this.store = store || new DocumentStore();
    this.chunker = new DocumentChunker();
  }

  /**
   * Index a single file: parse → chunk → store
   * @param {string} filePath - Path to document
   * @returns {Promise<number>} - Number of chunks created
   */
  async indexFile(filePath) {
    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const parser = getParser(resolved);
    if (!parser) {
      const ext = path.extname(resolved);
      throw new Error(`Unsupported file type: ${ext}. Supported: .pdf, .docx, .md, .txt`);
    }

    // Delete existing chunks for this file (re-index)
    this.store.deleteByFile(resolved);

    // Parse
    const rawChunks = await parser(resolved);
    if (!rawChunks || rawChunks.length === 0) {
      return 0;
    }

    // Chunk (split large sections)
    const processed = this.chunker.process(rawChunks);

    // Store
    this.store.saveChunks(processed);

    logAudit({
      action: 'index_file',
      file: resolved,
      raw_chunks: rawChunks.length,
      stored_chunks: processed.length
    });

    return processed.length;
  }

  /**
   * Index a buffer (e.g. from Telegram file upload)
   * @param {Buffer} buffer - File contents
   * @param {string} filename - Original filename
   * @returns {Promise<number>} - Number of chunks created
   */
  async indexBuffer(buffer, filename) {
    // Write to temp file, index it, then clean up
    const tmpDir = path.join(require('../config').MULTIS_DIR, 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    const tmpPath = path.join(tmpDir, filename);
    fs.writeFileSync(tmpPath, buffer);

    try {
      const count = await this.indexFile(tmpPath);
      return count;
    } finally {
      // Clean up temp file
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    }
  }

  /**
   * Index all supported files in a directory
   * @param {string} dirPath - Directory path
   * @param {boolean} recursive - Recurse into subdirectories
   * @returns {Promise<{files: number, chunks: number}>}
   */
  async indexDirectory(dirPath, recursive = true) {
    const resolved = path.resolve(dirPath);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const supportedExts = ['.pdf', '.docx', '.md', '.txt'];
    let totalFiles = 0;
    let totalChunks = 0;

    const entries = fs.readdirSync(resolved, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(resolved, entry.name);

      if (entry.isDirectory() && recursive) {
        const sub = await this.indexDirectory(fullPath, true);
        totalFiles += sub.files;
        totalChunks += sub.chunks;
      } else if (entry.isFile() && supportedExts.includes(path.extname(entry.name).toLowerCase())) {
        try {
          const count = await this.indexFile(fullPath);
          totalFiles++;
          totalChunks += count;
        } catch (err) {
          logAudit({ action: 'index_error', file: fullPath, error: err.message });
        }
      }
    }

    return { files: totalFiles, chunks: totalChunks };
  }

  /**
   * Search indexed documents
   * @param {string} query - Search query
   * @param {number} limit - Max results
   * @returns {Array} - Matching chunks
   */
  search(query, limit = 5) {
    return this.store.search(query, limit);
  }

  /**
   * Get indexing stats
   */
  getStats() {
    return this.store.getStats();
  }

  close() {
    this.store.close();
  }
}

module.exports = { DocumentIndexer };
