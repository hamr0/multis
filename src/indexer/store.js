const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { MULTIS_DIR } = require('../config');

const DB_PATH = path.join(MULTIS_DIR, 'documents.db');

// ACT-R base-level activation: B_i = ln(Σ t_j^-d)
// where t_j = seconds since j-th access, d = decay rate (default 0.5)
const DEFAULT_DECAY = 0.5;
const ACTIVATION_WEIGHT = 2.0; // how much activation influences final rank

// Handle double-stringified JSON (e.g. '"[\\"a\\"]"' → ["a"])
function safeParseArray(raw) {
  let parsed = JSON.parse(raw || '[]');
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * DocumentStore - SQLite storage for document chunks with FTS5 search.
 * Ported from aurora_core.store.sqlite (Python).
 * ACT-R activation blended with BM25 for retrieval ranking.
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
        element_type TEXT DEFAULT 'txt',
        name TEXT DEFAULT '',
        content TEXT DEFAULT '',
        parent_chunk_id TEXT,
        section_path TEXT DEFAULT '[]',
        section_level INTEGER DEFAULT 0,
        type TEXT DEFAULT 'kb',
        metadata TEXT DEFAULT '{}',
        role TEXT DEFAULT 'public',
        -- Activation columns for ACT-R (POC5)
        activation REAL DEFAULT 0.0,
        access_count INTEGER DEFAULT 0,
        last_accessed TEXT,
        -- Timestamps
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_element ON chunks(element_type);
      CREATE INDEX IF NOT EXISTS idx_chunks_type_v2 ON chunks(type);
      CREATE INDEX IF NOT EXISTS idx_chunks_role ON chunks(role);
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

    // Migration: add type/role columns if missing (existing DBs have document_type/scope)
    try {
      this.db.prepare('SELECT type FROM chunks LIMIT 0').get();
    } catch {
      this.db.exec(`
        ALTER TABLE chunks ADD COLUMN type TEXT DEFAULT 'kb';
        ALTER TABLE chunks ADD COLUMN role TEXT DEFAULT 'public';
        UPDATE chunks SET type = 'conv' WHERE document_type = 'conversation';
        UPDATE chunks SET role = 'public' WHERE scope = 'kb';
        UPDATE chunks SET role = scope WHERE scope != 'kb';
        UPDATE chunks SET element_type = 'chat' WHERE document_type = 'conversation';
        UPDATE chunks SET element_type = document_type WHERE document_type IN ('pdf','docx','md','txt');
        CREATE INDEX IF NOT EXISTS idx_chunks_type_v2 ON chunks(type);
        CREATE INDEX IF NOT EXISTS idx_chunks_role ON chunks(role);
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
         parent_chunk_id, section_path, section_level, type, metadata,
         role, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      chunk.chunkId,
      chunk.filePath,
      chunk.pageStart,
      chunk.pageEnd,
      chunk.element,
      chunk.name,
      chunk.content,
      chunk.parentChunkId,
      JSON.stringify(chunk.sectionPath),
      chunk.sectionLevel,
      chunk.type,
      JSON.stringify(chunk.metadata),
      chunk.role || 'public',
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
   * BM25 + ACT-R activation search using FTS5.
   * Fetches 3x candidates, computes blended score, returns top `limit`.
   * @param {string} query - Search query
   * @param {number} limit - Max results
   * @param {Object} options - { roles: string[], decay: number, types: string[] }
   * @returns {Array} - Chunks sorted by blended relevance
   */
  search(query, limit = 10, options = {}) {
    // Convert natural language to FTS5 OR query
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

    // Build role and type filters if provided
    const { roles, scopes, decay, types } = options;
    // Support both 'roles' (new) and 'scopes' (backward compat)
    const effectiveRoles = roles || scopes;
    let roleClause = '';
    let typeClause = '';
    const params = [ftsQuery];
    if (effectiveRoles && effectiveRoles.length > 0) {
      const placeholders = effectiveRoles.map(() => '?').join(', ');
      roleClause = `AND c.role IN (${placeholders})`;
      params.push(...effectiveRoles);
    }
    if (types && types.length > 0) {
      const tp = types.map(() => '?').join(', ');
      typeClause = `AND c.type IN (${tp})`;
      params.push(...types);
    }
    // Fetch 3x candidates for activation re-ranking
    const candidateLimit = limit * 3;
    params.push(candidateLimit);

    const stmt = this.db.prepare(`
      SELECT c.*, rank
      FROM chunks_fts fts
      JOIN chunks c ON fts.chunk_id = c.chunk_id
      WHERE chunks_fts MATCH ?
      ${roleClause}
      ${typeClause}
      ORDER BY rank
      LIMIT ?
    `);

    const rows = stmt.all(...params);

    // Map rows and compute blended score
    const results = rows.map(row => {
      // BM25 rank is negative (lower = more relevant), normalize to positive
      const bm25Score = -row.rank;
      // Use cached activation or compute live
      const act = row.activation || this.computeActivation(row.chunk_id, decay || DEFAULT_DECAY);
      // Blended: BM25 + weighted activation
      const blended = bm25Score + ACTIVATION_WEIGHT * act;

      return {
        chunkId: row.chunk_id,
        filePath: row.file_path,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        element: row.element_type,
        name: row.name,
        content: row.content,
        parentChunkId: row.parent_chunk_id,
        sectionPath: safeParseArray(row.section_path),
        sectionLevel: row.section_level,
        type: row.type,
        metadata: JSON.parse(row.metadata || '{}'),
        role: row.role,
        activation: act,
        bm25: bm25Score,
        rank: blended,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });

    // Sort by blended score descending (higher = more relevant), take top limit
    results.sort((a, b) => b.rank - a.rank);
    return results.slice(0, limit);
  }

  /**
   * Get most recent chunks by type, without FTS matching.
   * Used as fallback when search query is all stopwords.
   */
  recentByType(limit = 5, options = {}) {
    const { roles, scopes, types } = options;
    const effectiveRoles = roles || scopes;
    let roleClause = '';
    let typeClause = '';
    const params = [];
    if (effectiveRoles && effectiveRoles.length > 0) {
      const placeholders = effectiveRoles.map(() => '?').join(', ');
      roleClause = `AND role IN (${placeholders})`;
      params.push(...effectiveRoles);
    }
    if (types && types.length > 0) {
      const tp = types.map(() => '?').join(', ');
      typeClause = `AND type IN (${tp})`;
      params.push(...types);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT * FROM chunks
      WHERE 1=1 ${roleClause} ${typeClause}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params);

    return rows.map(row => ({
      chunkId: row.chunk_id,
      filePath: row.file_path,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      element: row.element_type,
      name: row.name,
      content: row.content,
      parentChunkId: row.parent_chunk_id,
      sectionPath: safeParseArray(row.section_path),
      sectionLevel: row.section_level,
      type: row.type,
      metadata: JSON.parse(row.metadata || '{}'),
      role: row.role,
      activation: row.activation,
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
      sectionPath: safeParseArray(row.section_path),
      type: row.type,
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
      'SELECT type, COUNT(*) as count FROM chunks GROUP BY type'
    ).all();
    const files = this.db.prepare(
      'SELECT DISTINCT file_path FROM chunks'
    ).all();
    return {
      totalChunks: total.count,
      byType: Object.fromEntries(byType.map(r => [r.type, r.count])),
      indexedFiles: files.length
    };
  }

  /**
   * Compute ACT-R base-level activation for a chunk.
   * B_i = ln(Σ t_j^-d) where t_j = seconds since j-th access, d = decay
   * Returns 0.0 if chunk has never been accessed.
   */
  computeActivation(chunkId, decay = DEFAULT_DECAY) {
    const rows = this.db.prepare(
      'SELECT accessed_at FROM access_history WHERE chunk_id = ? ORDER BY accessed_at DESC LIMIT 50'
    ).all(chunkId);

    if (rows.length === 0) return 0.0;

    const now = Date.now();
    let sum = 0;
    for (const row of rows) {
      const ageSec = (now - new Date(row.accessed_at).getTime()) / 1000;
      // Floor at 1 second to avoid infinity for very recent accesses
      const age = Math.max(ageSec, 1);
      sum += Math.pow(age, -decay);
    }

    // Use ln(1 + sum) to ensure positive activation for any access
    // Standard ACT-R uses ln(sum) but that gives 0 for a single recent access
    return sum > 0 ? Math.log(1 + sum) : 0.0;
  }

  /**
   * Record a search access for ACT-R activation tracking.
   * Updates access_history and the cached activation value on the chunk.
   */
  recordAccess(chunkId, query) {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO access_history (chunk_id, accessed_at, query) VALUES (?, ?, ?)'
    ).run(chunkId, now, query);

    // Recompute and cache activation
    const activation = this.computeActivation(chunkId);
    this.db.prepare(
      'UPDATE chunks SET access_count = access_count + 1, last_accessed = ?, activation = ? WHERE chunk_id = ?'
    ).run(now, activation, chunkId);
  }

  /**
   * Record access for multiple chunks from a search (batch, in transaction).
   */
  recordSearchAccess(chunkIds, query) {
    if (!chunkIds || chunkIds.length === 0) return;
    const tx = this.db.transaction((ids) => {
      for (const id of ids) {
        this.recordAccess(id, query);
      }
    });
    tx(chunkIds);
  }

  close() {
    this.db.close();
  }
}

module.exports = { DocumentStore, DB_PATH };
