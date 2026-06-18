'use strict';
/**
 * src/context/index.js — multis's thin POLICY layer over litectx.
 *
 * litectx (ESM) owns ALL storage: ingest, format-convert, chunk, blob-store,
 * scope-filter, recall, retention. multis keeps NO homegrown index/memory store
 * (M3: src/indexer/* deleted). This module only shapes POLICY onto litectx's
 * primitives — which scope a chat maps to, and retention TTLs. litectx is
 * ESM, dynamic-imported from CJS (same pattern as bareguard).
 *
 * Scope model — litectx R2 per-call `scope` IS multis's tenant isolation:
 *   kb    → scope = null      (global; visible from every chat)
 *   admin → scope = 'admin'   (owner-private)
 *   chat  → scope = 'chat:<id>'(customer)
 * recall({scope}) returns `scope ∪ null-global`, so the security model falls
 * straight out of the primitive: owner(admin) recall = admin ∪ kb; customer
 * recall = own ∪ kb — never another customer, never admin.
 *
 * One LiteCtx per process (like the bareguard Gate). Isolation is per-CALL
 * scope, never the instance `owner` (one process serves every chat).
 */
const path = require('path');
const fs = require('fs');
const { PATHS } = require('../config');

let _ctx = null;
let _initP = null;

const KB_SCOPE = null;
const ADMIN_SCOPE = 'admin';
/** Customer chat scope key. */
function chatScope(chatId) { return `chat:${chatId}`; }
/** Map the legacy /index role ('public' | 'admin') to a litectx scope. */
function roleToScope(role) { return role === 'admin' ? ADMIN_SCOPE : KB_SCOPE; }

/**
 * Construct (once) the process-wide LiteCtx. Idempotent and concurrency-safe.
 * @param {{ writeGate?: object, writeAudit?: object }} [opts]
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

const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

/** Ingest an uploaded document buffer (pdf/docx→md→chunk; md→chunk; else byte-exact blob). */
async function indexBuffer(buffer, filename, scope, { expiresAt = null } = {}) {
  return ctx().ingest(toU8(buffer), { filename, scope, expiresAt });
}

/** Ingest a document from a filesystem path (the /index <path> flow). */
async function indexFile(filePath, scope, { expiresAt = null } = {}) {
  return indexBuffer(fs.readFileSync(filePath), path.basename(filePath), scope, { expiresAt });
}

let _memSeq = 0;
/**
 * Persist a memory summary as a scope-tagged doc row (litectx scopes facts by
 * INSTANCE owner, not per-call — so per-chat memory rides the doc/blob scope
 * axis). Tagged `meta.type='memory'` to tell memory rows from real uploads.
 */
async function rememberMemory(scope, text, { expiresAt = null, meta = {} } = {}) {
  const id = `mem-${Date.now()}-${_memSeq++}`;
  return ctx().ingest(toU8(Buffer.from(String(text))), {
    filename: `${id}.md`,
    scope,
    expiresAt,
    meta: { ...meta, type: 'memory' },
  });
}

/**
 * Unified recall (docs + memory, both kind=doc), mapped to the chunk shape
 * buildRAGPrompt/buildMemorySystemPrompt consume ({ name, content }).
 */
async function search(query, { scope = null, n = 5 } = {}) {
  const hits = await ctx().recall(query, { kind: 'doc', scope, n, body: true });
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
  return ctx().get(id, scope !== undefined ? { scope } : {});
}

/** Reclaim storage for rows past their expiresAt (R5). The retention sweep calls this. */
async function purge() {
  return ctx().purge();
}

/** Escape hatch to the raw LiteCtx for verbs not yet wrapped. */
function raw() { return ctx(); }

module.exports = {
  init, raw,
  indexFile, indexBuffer, rememberMemory, search, get, purge,
  KB_SCOPE, ADMIN_SCOPE, chatScope, roleToScope,
};
