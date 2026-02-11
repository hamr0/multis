const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { MULTIS_DIR } = require('../config');

const DB_PATH = path.join(MULTIS_DIR, 'documents.db');

/**
 * DocumentStore - SQLite storage for document chunks with FTS5 search.
 * Ported from aurora_core.store.sqlite (Python).
 * Includes activation columns for future ACT-R (POC5).
 */
class DocumentStore {
  constructor(dbPath = DB_PATH) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        page_start INTEGER DEFAULT 0,
        page_end INTEGER DEFAULT 0,
        element_type TEXT DEFAULT 'paragraph',
        name TEXT DEFAULT '',
        content TEXT DEFAULT '',
        parent_chunk_id TEXT,
        section_path TEXT DEFAULT '[]',
        section_level INTEGER DEFAULT 0,
        document_type TEXT DEFAULT 'unknown',
        metadata TEXT DEFAULT '{}',
        -- Activation columns for ACT-R (POC5)
        activation REAL DEFAULT 0.0,
        access_count INTEGER DEFAULT 0,
        last_accessed TEXT,
        -- Timestamps
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(element_type);
      CREATE INDEX IF NOT EXISTS idx_chunks_doc_type ON chunks(document_type);
      CREATE INDEX IF NOT EXISTS idx_chunks_activation ON chunks(activation DESC);

      -- FTS5 virtual table for full-text search (BM25)
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id UNINDEXED,
        name,
        content,
        section_path,
        content=chunks,
        content_rowid=rowid,
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, chunk_id, name, content, section_path)
        VALUES (new.rowid, new.chunk_id, new.name, new.content, new.section_path);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, chunk_id, name, content, section_path)
        VALUES ('delete', old.rowid, old.chunk_id, old.name, old.content, old.section_path);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, chunk_id, name, content, section_path)
        VALUES ('delete', old.rowid, old.chunk_id, old.name, old.content, old.section_path);
        INSERT INTO chunks_fts(rowid, chunk_id, name, content, section_path)
        VALUES (new.rowid, new.chunk_id, new.name, new.content, new.section_path);
      END;

      -- Access history for ACT-R activation tracking (POC5)
      CREATE TABLE IF NOT EXISTS access_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        query TEXT,
        FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_access_chunk ON access_history(chunk_id);
    `);

    // Migration: add scope column if missing
    try {
      this.db.prepare('SELECT scope FROM chunks LIMIT 0').get();
    } catch {
      this.db.exec(`
        ALTER TABLE chunks ADD COLUMN scope TEXT DEFAULT 'kb';
        CREATE INDEX IF NOT EXISTS idx_chunks_scope ON chunks(scope);
      `);
    }
  }

  /**
   * Save a DocChunk to the store (insert or replace)
   */
  saveChunk(chunk) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks
        (chunk_id, file_path, page_start, page_end, element_type, name, content,
         parent_chunk_id, section_path, section_level, document_type, metadata,
         scope, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      chunk.chunkId,
      chunk.filePath,
      chunk.pageStart,
      chunk.pageEnd,
      chunk.elementType,
      chunk.name,
      chunk.content,
      chunk.parentChunkId,
      JSON.stringify(chunk.sectionPath),
      chunk.sectionLevel,
      chunk.documentType,
      JSON.stringify(chunk.metadata),
      chunk.scope || 'kb',
      chunk.createdAt,
      chunk.updatedAt
    );
  }

  /**
   * Save multiple chunks in a transaction
   */
  saveChunks(chunks) {
    const tx = this.db.transaction((items) => {
      for (const chunk of items) {
        this.saveChunk(chunk);
      }
    });
    tx(chunks);
  }

  /**
   * BM25 full-text search using FTS5
   * @param {string} query - Search query
   * @param {number} limit - Max results
   * @returns {Array} - Chunks sorted by BM25 relevance
   */
  search(query, limit = 10, options = {}) {
    // Convert natural language to FTS5 OR query
    // Filter out stopwords, join remaining with OR for broader matching
    const stopwords = new Set(['a','an','the','is','are','was','were','be','been',
      'being','have','has','had','do','does','did','will','would','could','should',
      'may','might','can','i','me','my','we','our','you','your','he','she','it',
      'they','them','this','that','what','which','who','how','when','where','why',
      'not','no','so','if','or','and','but','in','on','at','to','for','of','with',
      'by','from','as','into','about','than','after','before']);

    const terms = query.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 1 && !stopwords.has(t));

    if (terms.length === 0) return [];

    const ftsQuery = terms.join(' OR ');

    // Build scope filter if provided
    const { scopes } = options;
    let scopeClause = '';
    const params = [ftsQuery];
    if (scopes && scopes.length > 0) {
      const placeholders = scopes.map(() => '?').join(', ');
      scopeClause = `AND c.scope IN (${placeholders})`;
      params.push(...scopes);
    }
    params.push(limit);

    const stmt = this.db.prepare(`
      SELECT c.*, rank
      FROM chunks_fts fts
      JOIN chunks c ON fts.chunk_id = c.chunk_id
      WHERE chunks_fts MATCH ?
      ${scopeClause}
      ORDER BY rank
      LIMIT ?
    `);

    const rows = stmt.all(...params);
    return rows.map(row => ({
      chunkId: row.chunk_id,
      filePath: row.file_path,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      elementType: row.element_type,
      name: row.name,
      content: row.content,
      parentChunkId: row.parent_chunk_id,
      sectionPath: JSON.parse(row.section_path || '[]'),
      sectionLevel: row.section_level,
      documentType: row.document_type,
      metadata: JSON.parse(row.metadata || '{}'),
      scope: row.scope,
      activation: row.activation,
      rank: row.rank,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  /**
   * Get chunk by ID
   */
  getChunk(chunkId) {
    const row = this.db.prepare('SELECT * FROM chunks WHERE chunk_id = ?').get(chunkId);
    if (!row) return null;
    return {
      chunkId: row.chunk_id,
      filePath: row.file_path,
      name: row.name,
      content: row.content,
      sectionPath: JSON.parse(row.section_path || '[]'),
      documentType: row.document_type,
      activation: row.activation
    };
  }

  /**
   * Delete all chunks for a file (for re-indexing)
   */
  deleteByFile(filePath) {
    this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
  }

  /**
   * Get stats about indexed documents
   */
  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get();
    const byType = this.db.prepare(
      'SELECT document_type, COUNT(*) as count FROM chunks GROUP BY document_type'
    ).all();
    const files = this.db.prepare(
      'SELECT DISTINCT file_path FROM chunks'
    ).all();
    return {
      totalChunks: total.count,
      byType: Object.fromEntries(byType.map(r => [r.document_type, r.count])),
      indexedFiles: files.length
    };
  }

  /**
   * Record a search access for ACT-R activation tracking (POC5)
   */
  recordAccess(chunkId, query) {
    this.db.prepare(
      'INSERT INTO access_history (chunk_id, accessed_at, query) VALUES (?, ?, ?)'
    ).run(chunkId, new Date().toISOString(), query);

    this.db.prepare(
      'UPDATE chunks SET access_count = access_count + 1, last_accessed = ? WHERE chunk_id = ?'
    ).run(new Date().toISOString(), chunkId);
  }

  close() {
    this.db.close();
  }
}

module.exports = { DocumentStore, DB_PATH };
