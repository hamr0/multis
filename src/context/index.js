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

/** Process-unique memory row id (Date.now() + seq survives a restart without collision). */
const memId = () => `mem-${Date.now()}-${_memSeq++}`;
const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const mapDocHit = (h) => ({ name: h.path, content: h.body || '', chunkId: h.path, format: h.format, score: h.score });
// Native memory hits carry `occurredAt` (epoch ms, episodes) + `provenance` via attachMemMeta.
// `createdAt` is surfaced as an ISO date for the recall_memory display (occurredAt for episodes;
// facts have none → null = "unknown date", acceptable for durable knowledge).
const mapMemHit = (h) => ({
  name: h.path,
  content: h.body || '',
  createdAt: h.occurredAt ? new Date(h.occurredAt).toISOString() : null,
  provenance: h.provenance || null,
  score: h.score,
});

/**
 * A scope-bound context handle over litectx's `scoped()` view (module-internal —
 * the public API is the per-call delegators below, which each obtain one of these).
 * Scope is fixed once, so no operation can be reached without it: `search`/`recallMemory`
 * recall `scope ∪ GLOBAL`, `indexBuffer`/`rememberEpisode`/`rememberFact` write to exactly the
 * bound scope, `get`/`forgetMemory` are fenced to it. `'kb'`/`'public'` bind the shared KB (GLOBAL).
 * @param {string} scope  'admin' | 'user:<chatId>' | 'public' | 'kb'
 */
function forScope(scope) {
  const view = ctx().scoped(toScope(scope));
  return {
    /** Unified document recall (RAG), mapped to {name, content} for the prompt builders. */
    async search(query, { n = 5 } = {}) {
      const hits = await view.recall(query, { kind: 'doc', n, body: true });
      return hits.map(mapDocHit);
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
    /** Fetch one row by id, fenced to the bound scope (R2 handle fence). */
    get(id) {
      return view.get(id);
    },

    // --- Native memory ladder (M4) — episodes (scratchpad) → facts (durable), no LLM. ---

    /**
     * Record one exchange as an `episode` (`by:'agent'`) — the scratchpad rung. Promotes to a
     * fact by USE (recall count), or expires at `expiresAt`. Tenant-fenced by the bound owner.
     */
    async rememberEpisode(text, { expiresAt = null, meta = {} } = {}) {
      return view.remember(memId(), String(text), { kind: 'episode', by: 'agent', expiresAt, meta });
    },
    /**
     * Write a durable `fact`. `by:'human'` for the explicit `/remember` (top trust); `by:'agent'`
     * is reserved for promotion (use {@link promotionSweep}). Facts don't expire unless `expiresAt` set.
     */
    async rememberFact(text, { by = 'human', expiresAt = null, meta = {} } = {}) {
      return view.remember(memId(), String(text), { kind: 'fact', by, expiresAt, meta });
    },
    /**
     * Recall durable facts + scratchpad episodes for this tenant, FACTS FIRST (durable over scratch).
     * `recall(kind:[…])` returns a grouped `{fact, episode}`; we flatten facts-then-episodes and cap at n.
     * Backs the recall_memory tool. NOTE: an all-stopword query yields no FTS match → `[]` (the doc-axis
     * `recentMemory` recency fallback does not cover the memory axis — a deferrable nicety, not amnesia).
     */
    async recallMemory(query, { n = 5 } = {}) {
      const g = await view.recall(query, { kind: ['fact', 'episode'], n, body: true });
      return [...(g.fact || []), ...(g.episode || [])].slice(0, n).map(mapMemHit);
    },
    /**
     * Promotion sweep (the ladder's agent rung): hot `episode`s (recalled ≥threshold within litectx's
     * 30-day active window) → durable `fact`s, copied VERBATIM (`by:'agent'`, no summarizer — litectx
     * flags, multis copies). The fact id is derived from the episode path so a re-sweep UPSERTS the same
     * fact rather than duplicating. Returns the count promoted. Cheap (a SQL query + N copies); the host
     * runs it fire-and-forget after a response.
     */
    async promotionSweep({ threshold } = {}) {
      const cands = view.promotionCandidates(threshold); // [{ path, hits }]
      let promoted = 0;
      for (const c of cands) {
        const ep = view.get(c.path);
        if (!ep || !ep.text) continue;
        await view.remember(`fact-${c.path}`, ep.text, { kind: 'fact', by: 'agent' });
        promoted++;
      }
      return promoted;
    },
    /**
     * Clear this tenant's whole conversational memory (`fact` + `episode`) — the `/forget` verb.
     * Tenant-fenced on the bound owner (litectx 0.22.0 `ScopedView.forget`, validated): removes ONLY
     * this scope's rows, never another tenant's and never the shared/global tier. Leaves uploaded docs
     * untouched (a separate axis). @returns {number} rows removed.
     */
    forgetMemory() {
      return view.forget();
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
// --- Native memory ladder (M4) — each delegates to a scope-bound handle (tenant-fenced). ---
const rememberEpisode = async (scope, text, opts = {}) => forScope(scope).rememberEpisode(text, opts);
const rememberFact = async (scope, text, opts = {}) => forScope(scope).rememberFact(text, opts);
const recallMemory = async (query, { scope, n = 5 } = {}) => forScope(scope).recallMemory(query, { n });
const promotionSweep = async (scope, opts = {}) => forScope(scope).promotionSweep(opts);
const forgetMemory = async (scope) => forScope(scope).forgetMemory();
/** @param {string} query @param {{ scope: string, n?: number }} opts  scope REQUIRED (fail-closed) */
const search = async (query, { scope, n = 5 } = {}) => forScope(scope).search(query, { n });
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
  indexFile, indexBuffer, search, get, purge, stats,
  // M4 native memory ladder
  rememberEpisode, rememberFact, recallMemory, promotionSweep, forgetMemory,
};
