'use strict';
/**
 * src/context/index.js — multis's thin POLICY layer over litectx.
 *
 * litectx (ESM) owns ALL storage: ingest, format-convert, chunk, blob-store,
 * scope-filter, recall, retention. multis keeps NO homegrown index/memory store
 * (M3: src/indexer/* deleted). This module only shapes POLICY onto litectx's
 * primitives. litectx is ESM, dynamic-imported from CJS (like bareguard).
 *
 * Scope vocabulary is multis-native (unchanged from the legacy store):
 *   'public' | 'kb' → litectx null  (global KB; visible from every chat)
 *   'admin'         → litectx 'admin' (owner-private)
 *   'user:<chatId>' → litectx 'user:<chatId>' (customer)
 * litectx R2 `recall({scope})` returns `scope ∪ null-global`, so the security
 * model falls straight out: owner(admin) recall = admin ∪ kb; customer recall =
 * own ∪ kb — never another customer, never admin. One LiteCtx per process;
 * isolation is the per-CALL scope, never the instance owner.
 */
const path = require('path');
const fs = require('fs');
const { PATHS } = require('../config');

let _ctx = null;
let _initP = null;
let _bounds = {};

/** Translate multis-native scope → litectx scope. 'public'/'kb' is the global (null) KB. */
function toLcxScope(scope) {
  if (scope == null || scope === 'public' || scope === 'kb') return null;
  return scope; // 'admin' / 'user:<chatId>' are litectx scope strings verbatim
}

/**
 * Construct (once) the process-wide LiteCtx. Idempotent and concurrency-safe.
 * @param {{ documents?: object, writeGate?: object, writeAudit?: object }} [opts]
 */
async function init(opts = {}) {
  if (_ctx) return _ctx;
  if (_initP) return _initP;
  _initP = (async () => {
    const { LiteCtx } = await import('litectx');
    const dataDir = path.dirname(PATHS.db());        // ~/.multis/data
    const root = path.join(dataDir, 'ctx');           // litectx root (inert: multis never index()-es a repo)
    const dbPath = path.join(dataDir, 'litectx.db');  // own DB — never collides with the legacy documents.db
    fs.mkdirSync(root, { recursive: true });
    const cfg = { root, dbPath };
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

/** Ingest an uploaded document buffer. @returns {Promise<number>} chunks produced (0 for a stored blob). */
async function indexBuffer(buffer, filename, scope, { expiresAt = null } = {}) {
  const r = await ctx().ingest(toU8(buffer), { filename, scope: toLcxScope(scope), expiresAt, ..._bounds });
  return r.chunks;
}

/** Ingest a document from a filesystem path (the /index <path> flow). @returns {Promise<number>} chunks. */
async function indexFile(filePath, scope, opts = {}) {
  return indexBuffer(fs.readFileSync(filePath), path.basename(filePath), scope, opts);
}

let _memSeq = 0;
/**
 * Persist a memory summary as a scope-tagged doc row. litectx scopes facts by
 * INSTANCE owner (not per-call), so per-chat memory rides the doc scope axis.
 * Tagged meta.type='memory' to distinguish memory rows from real uploads.
 */
async function rememberMemory(scope, text, { expiresAt = null, meta = {} } = {}) {
  const id = `mem-${Date.now()}-${_memSeq++}`;
  return ctx().ingest(toU8(Buffer.from(String(text))), {
    filename: `${id}.md`,
    scope: toLcxScope(scope),
    expiresAt,
    meta: { ...meta, type: 'memory' },
  });
}

/**
 * Unified recall (docs + memory, both kind=doc), mapped to the chunk shape
 * buildRAGPrompt/buildMemorySystemPrompt consume ({ name, content }).
 * @param {string} query
 * @param {{ scope?: string|null, n?: number }} [opts]
 */
async function search(query, { scope = null, n = 5 } = {}) {
  const hits = await ctx().recall(query, { kind: 'doc', scope: toLcxScope(scope), n, body: true });
  return hits.map((h) => ({
    name: h.path,
    content: h.body || '',
    chunkId: h.path,   // litectx tracks its own recall demand-signal; kept for caller back-compat
    format: h.format,
    score: h.score,
  }));
}

/** Fetch one row by id, scope-fenced (R2 handle fence). Pass the requesting scope on customer paths. */
async function get(id, scope) {
  return ctx().get(id, scope !== undefined ? { scope: toLcxScope(scope) } : {});
}

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
  indexFile, indexBuffer, rememberMemory, search, get, purge, stats,
};
