'use strict';
/**
 * src/context/index.js — multis's thin POLICY layer over litectx.
 *
 * litectx (ESM) owns ALL storage: ingest, format-convert, chunk, blob-store,
 * scope-filter, recall, retention — AND, since 0.18.0, the multi-tenant FENCE
 * itself. multis keeps NO homegrown store and NO hand-rolled scope guard:
 *   - `strictScope: true` (set at init) → litectx fails CLOSED: a missing scope on
 *     recall/get/ingest THROWS instead of returning/writing every tenant's rows.
 *   - `GLOBAL` (litectx sentinel) → the shared knowledge base (maps to scope IS NULL).
 *   - `ctx.scoped(scope)` → a handle whose recall/get/ingest carry the bound scope,
 *     so a call site has no per-call scope to forget.
 *
 * This module only maps multis's scope vocabulary onto those primitives and shapes
 * litectx hits into the {name, content} chunks the prompt builders consume. Scope
 * vocabulary:
 *   'public' | 'kb' → litectx GLOBAL  (shared KB; unioned into every tenant recall)
 *   'admin'         → 'admin'          (owner-private)
 *   'user:<chatId>' → 'user:<chatId>'  (one customer)
 * A bound tenant scope recalls `scope ∪ GLOBAL` and writes to exactly that scope;
 * GLOBAL recalls/writes only the shared KB. There is no "see everything" path — a
 * missing scope is a bug and throws. litectx is ESM, dynamic-imported from CJS.
 */
const path = require('path');
const fs = require('fs');
const { PATHS } = require('../config');

let _ctx = null;
let _initP = null;
let _bounds = {};
let _GLOBAL = null;
let _memSeq = 0;

/**
 * Map a multis-native scope → the litectx scope value for a `scoped()` handle.
 * ONE translator for read AND write. Fail-closed: a missing scope throws (a
 * forgotten scope is a bug, not "see everything"); litectx's `strictScope` is the
 * backstop if a null ever slips past here. 'public'/'kb' is the shared KB (GLOBAL).
 */
function toScope(scope) {
  if (scope == null) {
    throw new Error(
      `context: a scope is required (got ${String(scope)}) — pass 'admin', ` +
      `'user:<chatId>', or 'kb'/'public' for the shared KB`
    );
  }
  if (scope === 'public' || scope === 'kb') return _GLOBAL;
  return scope; // 'admin' / 'user:<chatId>' are litectx scope strings verbatim
}

/**
 * Construct (once) the process-wide LiteCtx in fail-closed multi-tenant mode.
 * Idempotent and concurrency-safe.
 * @param {{ documents?: object, writeGate?: object, writeAudit?: object }} [opts]
 */
async function init(opts = {}) {
  if (_ctx) return _ctx;
  if (_initP) return _initP;
  _initP = (async () => {
    const { LiteCtx, GLOBAL } = await import('litectx');
    _GLOBAL = GLOBAL;
    const dataDir = path.dirname(PATHS.db());        // ~/.multis/data
    const root = path.join(dataDir, 'ctx');           // litectx root (inert: multis never index()-es a repo)
    const dbPath = path.join(dataDir, 'litectx.db');  // own DB
    fs.mkdirSync(root, { recursive: true });
    const cfg = { root, dbPath, strictScope: true };  // fail-closed: missing scope throws (multis is multi-tenant)
    if (opts.writeGate) cfg.writeGate = opts.writeGate;
    if (opts.writeAudit) cfg.writeAudit = opts.writeAudit;
    _ctx = new LiteCtx(cfg);
    return _ctx;
  })();
  _ctx = await _initP;
  _initP = null;
  return _ctx;
}

function ctx() {
  if (!_ctx) throw new Error('context: call init() at startup before use');
  return _ctx;
}

/** Set the untrusted-input bounds applied to every ingest (from config.documents). */
function setBounds(documents = {}) {
  _bounds = {};
  if (documents.maxSize != null) _bounds.maxSize = documents.maxSize;
  if (documents.maxPdfPages != null) _bounds.maxPages = documents.maxPdfPages;
  if (documents.parseTimeoutMs != null) _bounds.parseTimeoutMs = documents.parseTimeoutMs;
}

const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const mapDocHit = (h) => ({ name: h.path, content: h.body || '', chunkId: h.path, format: h.format, score: h.score });
const mapMemHit = (h) => ({ name: h.path, content: h.body || '', createdAt: h.meta?.createdAt || null, score: h.score });

/**
 * A scope-bound context handle over litectx's `scoped()` view (module-internal —
 * the public API is the per-call delegators below, which each obtain one of these).
 * Scope is fixed once, so no operation can be reached without it: `search` recalls
 * `scope ∪ GLOBAL`, `indexBuffer`/`rememberMemory` write to exactly the bound scope,
 * `get` is fenced to it. `'kb'`/`'public'` bind the shared KB (GLOBAL).
 * @param {string} scope  'admin' | 'user:<chatId>' | 'public' | 'kb'
 */
function forScope(scope) {
  const view = ctx().scoped(toScope(scope));
  return {
    /** Unified recall (docs + memory), mapped to {name, content} for the prompt builders. */
    async search(query, { n = 5 } = {}) {
      const hits = await view.recall(query, { kind: 'doc', n, body: true });
      return hits.map(mapDocHit);
    },
    /**
     * Memory-only recall for the recall_memory tool — same fence as search(), filtered
     * to rows written by rememberMemory (meta.type==='memory'). Over-fetches then slices
     * since recall mixes docs + memory in one kind:'doc' ranking.
     *
     * Recency fallback (litectx 0.20.0 `recentMemory`): an all-stopword query
     * (e.g. "what did I say") yields an empty FTS match, so recall ranks nothing and
     * returns []. We then surface the most recent memory rows for the scope instead —
     * scope-fenced + expiry-aware via the bound `view`, the same fence as recall. This
     * restores the legacy `recentByType` tie-break that M3 dropped (the ask is now
     * DELIVERED; validated against the published 0.20.0 artifact).
     */
    async searchMemory(query, { n = 5 } = {}) {
      const hits = await view.recall(query, { kind: 'doc', n: n * 4, body: true });
      const mem = hits.filter((h) => h.meta && h.meta.type === 'memory');
      if (mem.length > 0) return mem.slice(0, n).map(mapMemHit);
      const recent = await view.recentMemory({ n: n * 4, body: true });
      return recent.filter((h) => h.meta && h.meta.type === 'memory').slice(0, n).map(mapMemHit);
    },
    /**
     * Ingest an uploaded document buffer into the bound scope.
     * @returns {Promise<{chunks:number, mode:string}>} chunk count + litectx mode
     *   ('chunked' = searchable; 'blob' = stored-only, not recallable). The host
     *   surfaces `mode` so a 0-chunk ingest reads as "stored, not searchable"
     *   rather than a misleading success.
     */
    async indexBuffer(buffer, filename, { expiresAt = null } = {}) {
      const r = await view.ingest(toU8(buffer), { filename, expiresAt, ..._bounds });
      return { chunks: r.chunks, mode: r.mode };
    },
    /** Ingest a document from a filesystem path (the /index <path> flow). @returns {Promise<{chunks:number, mode:string}>} */
    async indexFile(filePath, opts = {}) {
      return this.indexBuffer(fs.readFileSync(filePath), path.basename(filePath), opts);
    },
    /**
     * Persist a memory summary as a scope-tagged doc row. Tagged meta.type='memory'
     * (forced last) so it's always distinguishable from an uploaded document on recall.
     */
    async rememberMemory(text, { expiresAt = null, meta = {} } = {}) {
      const id = `mem-${Date.now()}-${_memSeq++}`;
      return view.ingest(toU8(Buffer.from(String(text))), {
        filename: `${id}.md`,
        expiresAt,
        // createdAt rides meta so recall_memory can date a hit (litectx's occurredAt is
        // fact/episode-only; our memory rides the doc axis). type='memory' forced last.
        meta: { createdAt: new Date().toISOString(), ...meta, type: 'memory' },
      });
    },
    /** Fetch one row by id, fenced to the bound scope (R2 handle fence). */
    get(id) {
      return view.get(id);
    },
  };
}

// --- Top-level convenience API — each delegates to a scope-bound forScope() handle,
//     so every storage op goes through litectx's scoped() fence + strictScope. ---

// `async` so a synchronous toScope() throw (missing scope) surfaces as a rejected
// promise, uniform with the storage I/O — not a sync throw beside it.
/** @param {string} scope @returns {Promise<{chunks:number, mode:string}>} */
const indexBuffer = async (buffer, filename, scope, opts = {}) => forScope(scope).indexBuffer(buffer, filename, opts);
/** @param {string} scope @returns {Promise<{chunks:number, mode:string}>} */
const indexFile = async (filePath, scope, opts = {}) => forScope(scope).indexFile(filePath, opts);
const rememberMemory = async (scope, text, opts = {}) => forScope(scope).rememberMemory(text, opts);
/** @param {string} query @param {{ scope: string, n?: number }} opts  scope REQUIRED (fail-closed) */
const search = async (query, { scope, n = 5 } = {}) => forScope(scope).search(query, { n });
/** @param {string} query @param {{ scope: string, n?: number }} opts  scope REQUIRED (fail-closed) */
const searchMemory = async (query, { scope, n = 5 } = {}) => forScope(scope).searchMemory(query, { n });
/** Fetch one row by id, fenced to scope (R2 handle fence). */
const get = (id, scope) => forScope(scope).get(id);

/** Reclaim storage for rows past their expiresAt (R5). The retention sweep calls this. */
async function purge() {
  return ctx().purge();
}

/** Coarse index stats for /docs. litectx exposes a total item count (docs + memory). */
function stats() {
  return { total: ctx().store.count() };
}

/** Escape hatch to the raw LiteCtx. */
function raw() { return ctx(); }

module.exports = {
  init, setBounds, raw,
  indexFile, indexBuffer, rememberMemory, search, searchMemory, get, purge, stats,
};
