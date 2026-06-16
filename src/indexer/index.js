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
  constructor(store = null, limits = {}) {
    this.store = store || new DocumentStore();
    this.chunker = new DocumentChunker();
    // Bound untrusted attachment input. Defaults match the config template;
    // createMessageRouter passes config.documents through.
    this.maxSize = limits.maxSize ?? 10 * 1024 * 1024;
    this.maxPdfPages = limits.maxPdfPages ?? 2000;
    this.parseTimeoutMs = limits.parseTimeoutMs ?? 30000;
  }

  /**
   * Race a parse against a wall-clock deadline so a pathological document can't
   * hang the indexer indefinitely. pdfjs can't be cancelled cleanly, so the
   * page cap (enforced in parsePDF) is the real OOM guard; this bounds latency.
   */
  _withTimeout(promise, ms, label) {
    if (!ms) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Parse timed out after ${ms}ms: ${path.basename(label)}`)),
        ms
      );
      if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Index a single file: parse → chunk → store
   * @param {string} filePath - Path to document
   * @returns {Promise<number>} - Number of chunks created
   */
  async indexFile(filePath, scope = 'kb') {
    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Enforce the size cap before parsing — a malicious/oversized document is
    // rejected before it can be loaded into memory.
    if (this.maxSize) {
      const { size } = fs.statSync(resolved);
      if (size > this.maxSize) {
        throw new Error(
          `File too large: ${(size / 1048576).toFixed(1)} MB exceeds limit of ${(this.maxSize / 1048576).toFixed(1)} MB`
        );
      }
    }

    const parser = getParser(resolved);
    if (!parser) {
      const ext = path.extname(resolved);
      throw new Error(`Unsupported file type: ${ext}. Supported: .pdf, .docx, .md, .txt`);
    }

    // Delete existing chunks for this file (re-index)
    this.store.deleteByFile(resolved);

    // Parse (page cap + wall-clock timeout bound untrusted input)
    const rawChunks = await this._withTimeout(
      parser(resolved, { maxPages: this.maxPdfPages }),
      this.parseTimeoutMs,
      resolved
    );
    if (!rawChunks || rawChunks.length === 0) {
      return 0;
    }

    // Chunk (split large sections)
    const processed = this.chunker.process(rawChunks);

    // Set role on each chunk
    for (const chunk of processed) {
      chunk.role = scope;
    }

    // Store
    this.store.saveChunks(processed);

    logAudit({
      action: 'index_file',
      file: resolved,
      scope,
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
  async indexBuffer(buffer, filename, scope = 'kb') {
    // Write to temp file, index it, then clean up
    const tmpDir = path.join(require('../config').MULTIS_DIR, 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // filename is attacker-controlled (a chat sender names the attachment), so
    // strip any directory components before joining — basename neutralizes
    // path traversal (`../../etc/x`, absolute paths) while preserving the
    // extension the parser dispatches on. Reject degenerate names outright.
    const safeName = path.basename(filename || '');
    if (!safeName || safeName === '.' || safeName === '..') {
      throw new Error('Invalid attachment filename');
    }

    const tmpPath = path.join(tmpDir, safeName);
    fs.writeFileSync(tmpPath, buffer);

    try {
      const count = await this.indexFile(tmpPath, scope);
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
  search(query, limit = 5, options = {}) {
    return this.store.search(query, limit, options);
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
