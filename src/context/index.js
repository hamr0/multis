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
let _assemble = null;  // litectx's pure `assemble(units, ctx)` verb (M5 budget-fit), captured at init
let _cosine = null;    // litectx's `cosine(a,b)` verb (M13 supersede pre-check), captured at init
let _embeddings = false; // whether this process loaded the embedder (config.memory.semantic) — gates M13

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
    const { LiteCtx, GLOBAL, assemble, cosine } = await import('litectx');
    _GLOBAL = GLOBAL;
    _assemble = assemble;  // M5: pure budget-fit verb (no instance/scope needed) — exposed via assembleUnits()
    _cosine = cosine;      // M13: same-vector cosine, paired with the instance embedder for the supersede pre-check
    _embeddings = !!opts.embeddings; // M13 pre-check only runs when the embedder is loaded (semantic mode)
    const dataDir = path.dirname(PATHS.db());        // ~/.multis/data
    const root = path.join(dataDir, 'ctx');           // litectx root (inert: multis never index()-es a repo)
    const dbPath = path.join(dataDir, 'litectx.db');  // own DB
    fs.mkdirSync(root, { recursive: true });
    const cfg = { root, dbPath, strictScope: true };  // fail-closed: missing scope throws (multis is multi-tenant)
    // R4: semantic recall (BM25 + KNN paraphrase). Opt-in per call so the test suite stays BM25-only
    // (deterministic, no model load); production passes embeddings:true (config.memory.semantic).
    if (opts.embeddings) cfg.embeddings = true;
    // litectx 0.25.0: the episode retention+promotion window (config.memory.episode_window_days, default
    // 90). One coupled window — retention AND promote-eligibility. Unset → litectx's 30d default.
    if (opts.episodeWindowDays != null) cfg.episodeWindowDays = opts.episodeWindowDays;
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

/**
 * M5 context-engineering — litectx's `assemble(units, ctx)` budget-fit verb, surfaced through the one
 * module that imports litectx. Pure (no LiteCtx instance/scope): fits neutral transcript `units` to
 * `ctx.budget` tokens, recency-anchored, keeping `pinned`/`atomic` invariants and dropping oldest-first.
 * bare-agent's `unitAssembler` wraps this into the Loop's msgs-level `assemble(msgs, ctx)` seam. Throws if
 * called before init() (the dynamic import hasn't captured it yet) — but the Loop hook is fail-open, so a
 * throw degrades to sending full context, never a halt.
 * @param {Array<object>} units  neutral units (oldest → newest)
 * @param {{budget?:number, task?:string}} [assembleCtx]
 * @returns {Promise<{units:Array<object>, dropped:Array<{id:string,reason:string}>, tokens:number}>}
 */
function assembleUnits(units, assembleCtx) {
  if (!_assemble) throw new Error('context: call init() before assembleUnits()');
  return _assemble(units, assembleCtx);
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
let _lastOccurred = 0;
/**
 * Strictly-increasing episode timestamp. Stays ≈ now, but never equals/trails the previous write — so a
 * burst of same-millisecond episodes still orders deterministically. litectx `recentMemory` breaks ties on
 * `path` (not write-order), so without this a fast burst (or a test) reconstructs the conversation window
 * out of order (POC-confirmed against 0.23.0). Per-process monotonic, like `memId`'s seq.
 */
const nextOccurredAt = () => { _lastOccurred = Math.max(Date.now(), _lastOccurred + 1); return _lastOccurred; };
const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
// M13: embed one string with the process embedder (the SAME instance litectx loaded for semantic
// recall — no second model). `embed` may return a vector or a `[vector]`; normalize to a flat vector
// so litectx's `cosine` gets what it expects. Caller guards on _embeddings, so ctx().embedder exists.
const _embed = async (s) => { const r = await ctx().embedder.embed(String(s)); return Array.isArray(r[0]) ? r[0] : r; };
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
     * Record one exchange as an `episode` (`by:'agent'`) — the scratchpad rung. Promotes to a durable
     * fact by USE (recall count); otherwise litectx self-prunes it on a fixed 30-day rolling window.
     * Episodes carry NO per-row TTL (`expiresAt` is doc-axis only — ignored for fact/episode, litectx
     * 0.24.0), so durability is the promotion ladder, not an expiry. Tenant-fenced by the bound owner.
     */
    async rememberEpisode(text, { meta = {} } = {}) {
      return view.remember(memId(), String(text), { kind: 'episode', by: 'agent', occurredAt: nextOccurredAt(), meta });
    },
    /**
     * Write a durable `fact`. `by:'human'` for the explicit `/remember` (top trust); `by:'agent'`
     * is reserved for promotion (use {@link promotionSweep}). Facts are durable until `forget`.
     *
     * `id` (W4 supersession, litectx 0.24.0): when supplied, the write UPSERTS that id — re-asserting
     * the SAME (scope, id) REPLACES the prior value in place (no contradiction pile-up), tenant-fenced
     * so a given id under another tenant's scope is a different row. Omit `id` (the default) to mint a
     * fresh `memId()` — a brand-new fact. The caller decides "same subject → reuse the id" (see
     * src/memory/supersede.js); litectx only guarantees the keyed, fenced upsert.
     */
    async rememberFact(text, { by = 'human', id = null, meta = {} } = {}) {
      return view.remember(id || memId(), String(text), { kind: 'fact', by, meta });
    },
    /**
     * The existing durable facts most relevant to `text`, scope-fenced — the candidate set the
     * supersession judge weighs (W4). `log:false`: an internal same-subject check is not user demand,
     * so it must not inflate the recall/`use` signal. Returns `[{ id, text }]` (id = the public path,
     * re-passable to {@link rememberFact} as the upsert key).
     */
    async factCandidates(text, { n = 5 } = {}) {
      const hits = await view.recall(String(text), { kind: 'fact', n, body: true, log: false });
      // `score` = the recall's BM25/blended relevance (a keyword hit → >0; a shared/low-IDF term or a
      // pure-KNN nearest-neighbour → 0). Surfaced alongside `sim` so a caller can tell a genuine match
      // from KNN's always-present nearest neighbour (targeted /forget filters on score>0 || sim>=thresh).
      const cands = hits.map((h) => ({ id: h.path, text: h.body || '', score: h.score ?? 0 }));
      // M13 supersede pre-check: attach the semantic similarity (note ↔ candidate) so the caller can
      // skip the LLM judge when nothing is genuinely close (a low-cosine note can only be NEW). Only
      // when the embedder is loaded (semantic mode) — else `sim` is absent and the caller falls through
      // to the judge, byte-identical to the pre-M13 BM25-only path. An embed failure leaves `sim` absent
      // (same fall-through), so the pre-check is strictly additive and never blocks a /remember write.
      if (_embeddings && cands.length) {
        try {
          const q = await _embed(text);
          for (const c of cands) c.sim = _cosine(q, await _embed(c.text));
        } catch { /* embed error → leave sim absent → caller uses the LLM judge (fail-toward-keep) */ }
      }
      return cands;
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
    /**
     * Precise forget — delete ONE memory row by id (targeted `/forget <topic>`), tenant-safe.
     * The base `ctx.forget({id})` is owner-BLIND (deletes by id regardless of scope — the scoped view
     * rejects `{id}` on purpose), so we FIRST verify the id is in THIS scope via the scoped `get()`
     * (returns null cross-tenant — POC-proven) → a caller can never even TARGET an id outside its scope.
     * The residual (a blind delete matching the SAME id in another scope) can't occur here: every memory
     * id is minted globally-unique (`memId` = mem-<ts>-<seq>; promoted facts `fact-<uniqueEpisodeId>`;
     * W4 reuses an existing unique id), so no two scopes share one. A scoped delete-by-id would remove
     * the reliance on that invariant — a litectx gap, filed as an ask. CASCADE: a promoted fact carries
     * id `fact-<episodePath>` (see promotionSweep);
     * deleting only the fact lets the still-hot source episode RE-PROMOTE it on the next sweep (the
     * rebound bug), so we also delete that source episode — parsed straight from the id. Human
     * `/remember` facts (`mem-…` ids) have no source episode → the fact alone.
     * @returns {number} rows removed (0 if the id isn't this tenant's).
     */
    forgetById(id) {
      if (!id || !view.get(id)) return 0; // not this tenant's row (or already gone) → refuse the blind delete
      let removed = ctx().forget({ id });
      if (String(id).startsWith('fact-')) {
        const episodePath = String(id).slice('fact-'.length);
        if (view.get(episodePath)) removed += ctx().forget({ id: episodePath }); // kill the promotion root
      }
      return removed;
    },
    /**
     * Time-ordered recent memory for this tenant, newest-first (litectx 0.23.0 memory-axis `recentMemory`).
     * No FTS query, does NOT bump the promotion signal. Surfaces the opaque `meta` (where episode writes park
     * `turns`/role) + `kind` so the caller reconstructs a faithful conversation window WITHOUT parsing the body.
     * Backs the agent's message history (kind:'episode') and `/memory`.
     */
    async recentMemory({ kind = ['fact', 'episode'], n = 20 } = {}) {
      const hits = await view.recentMemory({ kind, n, body: true });
      return hits.map((h) => ({ ...mapMemHit(h), kind: h.kind, meta: h.meta || null }));
    },
    /** Per-tenant memory count by kind (litectx 0.23.0 O1) — tenant-fenced, expiry-aware. */
    async count({ kind } = {}) {
      return view.count(kind ? { kind } : {});
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
const factCandidates = async (scope, text, opts = {}) => forScope(scope).factCandidates(text, opts);
const recallMemory = async (query, { scope, n = 5 } = {}) => forScope(scope).recallMemory(query, { n });
const promotionSweep = async (scope, opts = {}) => forScope(scope).promotionSweep(opts);
const forgetMemory = async (scope) => forScope(scope).forgetMemory();
// Precise targeted forget by id (M14): tenant-verified + promotion-root cascade (see forgetById).
const forgetMemoryById = async (scope, id) => forScope(scope).forgetById(id);
// Time-ordered recency (litectx 0.23.0): the conversation window + /memory source from here (retires recent.json).
const recentMemory = async (scope, opts = {}) => forScope(scope).recentMemory(opts);
const countMemory = async (scope, opts = {}) => forScope(scope).count(opts);
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
  rememberEpisode, rememberFact, factCandidates, recallMemory, promotionSweep, forgetMemory,
  forgetMemoryById, recentMemory, countMemory,
  // M5 context-engineering
  assembleUnits,
};
