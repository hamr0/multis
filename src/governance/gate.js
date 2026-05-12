'use strict';

/**
 * Gate factory — wires bareguard 0.4.2 into multis via bare-agent 0.10.2's
 * `wireGate(gate, { actionTranslator })`.
 *
 * Single Gate per process (router-scoped via the carrier in handlers.js).
 * Shared audit file + budget file across all chats; humanChannel routes back to
 * the originating chat via `event.action._ctx.chatId`.
 *
 * bareguard is ESM ("type":"module"); multis is CommonJS. We lazily
 * `await import('bareguard')` on first use and cache the module.
 *
 * As of bareguard 0.4.2 / bare-agent 0.10.2 the seam is closed:
 *   - `bashCheck` and `fsCheck` accept `args.command` / `args.path` directly,
 *     so the translator only maps tool NAMES to bareguard types — no field
 *     hoisting (no `cmd:` / `path:` extraction).
 *   - `limits.maxToolRounds` ticks only on tool records, so our cap is a 1:1
 *     mapping from `config.llm.max_tool_rounds` (no *2 arithmetic).
 *
 * multis-specific behavior we keep on this side:
 *   - Owner-bypass: non-owners can't touch shell tools (`exec`, `read_file`,
 *     `grep_files`, `find_files`, `send_file`). Layered as a pre-check before
 *     wireGate.policy. Denied attempts are recorded to the gate audit.
 *   - Symlink resolution: args.path is realpath-resolved before fs.deny runs,
 *     so denied directories can't be reached via symlink.
 *   - send_file is translated to {type:'read'} so fs.deny gates outbound files.
 */

const fs = require('fs');
const path = require('path');
const { PATHS, getMultisDir } = require('../config');

let _bareguard = null;
let _wireGate = null;
let _defaultTranslator = null;

async function loadDeps() {
  if (!_bareguard) {
    _bareguard = await import('bareguard');
    const adapter = require('bare-agent');
    _wireGate = adapter.wireGate;
    _defaultTranslator = adapter.defaultActionTranslator;
  }
  return { bareguard: _bareguard, wireGate: _wireGate, defaultTranslator: _defaultTranslator };
}

/**
 * Build a Gate config object from multis governance.json + config.security.
 * Pure — no I/O, easy to test.
 */
function buildGateConfig({ governance, security, audit, budget, llm }) {
  const cfg = {};

  if (governance?.commands) {
    cfg.bash = {
      allow: governance.commands.allowlist || [],
      denyPatterns: (governance.commands.denylist || []).map(c => new RegExp(`^${escapeRegex(c)}(\\s|$)`, 'i')),
    };
  }

  if (governance?.paths) {
    cfg.fs = {
      readScope: (governance.paths.allowed || []).map(expandHome),
      writeScope: (governance.paths.allowed || []).map(expandHome),
      deny: (governance.paths.denied || []).map(expandHome),
    };
  }

  cfg.secrets = {
    envVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'TELEGRAM_BOT_TOKEN'],
    patterns: [/sk-[A-Za-z0-9]{40,}/, /ghp_[A-Za-z0-9]{36,}/],
  };

  cfg.content = {
    // multis injection patterns moved to askPatterns — humanChannel decides
    askPatterns: [
      /ignore\s+(all\s+)?(previous\s+)?instructions/i,
      /ignore\s+your\s+(instructions|rules|guidelines)/i,
      /disregard\s+(all\s+)?(previous\s+)?instructions/i,
      /reveal\s+(your|the)\s+(system|hidden|secret)/i,
      /jailbreak/i,
      /\bDAN\b/,
      /bypass\s+(security|restrictions|filters)/i,
      /act\s+as\s+(an?\s+)?admin/i,
      /pretend\s+(you('re| are)\s+)?(an?\s+)?admin/i,
      /you\s+are\s+now\s+(an?\s+)?/i,
      /show\s+(me\s+)?(all|other)\s+(users?|customers?|data)/i,
      /system\s+prompt/i,
    ],
  };

  if (budget && (budget.maxCostUsd != null || budget.maxTokens != null)) {
    cfg.budget = {};
    if (budget.maxCostUsd != null) cfg.budget.maxCostUsd = budget.maxCostUsd;
    if (budget.maxTokens != null) cfg.budget.maxTokens = budget.maxTokens;
    if (budget.sharedFile) cfg.budget.sharedFile = budget.sharedFile;
    if (budget.strict) cfg.budget.strict = true;
  }

  // bareguard 0.4.2 added limits.maxToolRounds — ticks only on non-"llm"
  // records, so it counts actual tool calls 1-for-1. No more *2 arithmetic.
  const rounds = llm?.max_tool_rounds || security?.max_tool_rounds;
  if (rounds) {
    cfg.limits = { maxToolRounds: rounds };
  }

  cfg.audit = audit || {};

  return cfg;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return process.env.HOME || process.env.USERPROFILE || '';
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(2));
  }
  return p;
}

/**
 * Resolve symlinks for fs actions before the gate checks the path. bareguard
 * 0.4.1+ reads the path from action.args.path (or action.path), so we mutate
 * args.path. Untouched if the file doesn't exist yet — the executor surfaces
 * that error.
 */
function resolveFsPath(action) {
  if (action.type === 'read' || action.type === 'write' || action.type === 'edit') {
    const p = action.args?.path;
    if (p) {
      try { action.args.path = fs.realpathSync(p); } catch { /* let executor handle */ }
    }
  }
  return action;
}

/**
 * Action translator passed to wireGate. Maps multis tool names to bareguard's
 * canonical types (bash, read). bareguard 0.4.1+ reads cmd/path out of
 * action.args directly via fallback, so we keep the verbatim args form — no
 * field hoisting. Path is expanded + symlink-resolved in args so fs.deny sees
 * the real absolute path.
 */
function makeActionTranslator(defaultTranslator) {
  return function multisActionTranslator(toolName, args, ctx) {
    const _ctx = ctx ?? null;
    if (toolName === 'exec') {
      return { type: 'bash', args, _ctx };
    }
    if (toolName === 'read_file' || toolName === 'send_file') {
      return resolveFsPath({ type: 'read', args: { ...args, path: expandHome(args?.path || '') }, _ctx });
    }
    if (toolName === 'grep_files' || toolName === 'find_files') {
      return resolveFsPath({ type: 'read', args: { ...args, path: expandHome(args?.path || '~') }, _ctx });
    }
    return defaultTranslator(toolName, args, _ctx);
  };
}

/**
 * Owner-bypass closure. multis' rule: non-owners can't touch shell tools.
 * Returns null (continue) or a deny string. Layered as a pre-check before
 * wireGate's policy.
 */
function ownerCheck(toolName, ctx) {
  const shellTools = new Set(['exec', 'read_file', 'grep_files', 'find_files']);
  if (!ctx?.isOwner && shellTools.has(toolName)) {
    return 'This tool requires owner privileges.';
  }
  return null;
}

/**
 * Synchronous accessor used by tests that build Gate config without async setup.
 * Returns the same translator wireGate would use internally given the same
 * defaultTranslator — useful for unit-asserting the translation.
 */
function translateAction(toolName, args, ctx, defaultTranslator = (n, a, c) => ({ type: n, args: a, _ctx: c ?? null })) {
  return makeActionTranslator(defaultTranslator)(toolName, args, ctx);
}

/**
 * Load governance.json from disk; defaults if missing.
 */
function loadGovernance() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.governance(), 'utf8'));
  } catch {
    return { commands: { allowlist: [], denylist: [] }, paths: { allowed: [], denied: [] } };
  }
}

/**
 * Create a Gate for the multis process. Shared budget + audit across all chats.
 *
 * @param {object} opts
 * @param {object} opts.config       multis config (security, llm, ...)
 * @param {Function} [opts.humanPrompt]  async (event) => { decision, reason?, newCap? }
 * @param {string} [opts.auditPath]  override audit file (default: ~/.multis/logs/gate.jsonl)
 * @param {string} [opts.budgetFile] override shared budget (default: ~/.multis/run/budget.json)
 * @param {boolean} [opts.fileless]  test mode — audit in memory, no fs writes
 * @returns {Promise<{gate, policy, onLlmResult, onToolResult, filterTools, HaltError}>}
 */
async function createGate(opts = {}) {
  const { bareguard, wireGate, defaultTranslator } = await loadDeps();
  const { Gate } = bareguard;
  const { HaltError } = require('bare-agent');

  const governance = opts.governance || loadGovernance();

  const auditPath = opts.fileless
    ? null  // explicit null → fileless in-memory (bareguard 0.4 B4)
    : (opts.auditPath || path.join(getMultisDir(), 'logs', 'gate.jsonl'));

  const budgetFile = opts.fileless
    ? undefined
    : (opts.budgetFile || path.join(getMultisDir(), 'run', 'budget.json'));

  const cfg = buildGateConfig({
    governance,
    security: opts.config?.security,
    llm: opts.config?.llm,
    audit: { path: auditPath },
    budget: {
      maxCostUsd: opts.config?.security?.max_cost_per_run,
      sharedFile: budgetFile,
    },
  });

  // humanChannel — collapses every ask/halt into one callback. Routes back to
  // the originating chat via event.action._ctx.chatId (bareguard 0.4 contract).
  cfg.humanChannel = async (event) => {
    if (!opts.humanPrompt) {
      return { decision: 'deny', reason: 'no humanPrompt registered' };
    }
    try {
      return await opts.humanPrompt(event);
    } catch (err) {
      return { decision: 'deny', reason: `humanPrompt threw: ${err.message}` };
    }
  };

  if (opts.config?.security?.checkpoint_timeout) {
    cfg.humanChannelTimeoutMs = opts.config.security.checkpoint_timeout * 1000;
  }

  const gate = new Gate(cfg);
  await gate.init();

  const wired = wireGate(gate, {
    actionTranslator: makeActionTranslator(defaultTranslator),
  });

  // Owner-bypass layered before wireGate.policy. wireGate.policy throws
  // HaltError on halt severity (caught by Loop) and returns deny strings
  // verbatim on action severity (LLM sees them).
  // Non-owner attempts are recorded to the gate audit so denied attempts
  // aren't silent — bareguard's policy() never runs on this branch otherwise.
  const policy = async (toolName, args, ctx) => {
    const ownerDeny = ownerCheck(toolName, ctx);
    if (ownerDeny) {
      try {
        const action = makeActionTranslator(defaultTranslator)(toolName, args, ctx);
        await gate.record(action, { phase: 'denied-owner', reason: ownerDeny });
      } catch { /* audit write must not break the deny path */ }
      return ownerDeny;
    }
    return wired.policy(toolName, args, ctx);
  };

  return {
    gate,
    policy,
    onLlmResult: wired.onLlmResult,
    onToolResult: wired.onToolResult,
    filterTools: wired.filterTools,
    HaltError,
  };
}

module.exports = {
  createGate,
  buildGateConfig,
  translateAction,
  ownerCheck,
  loadGovernance,
  makeActionTranslator,
};
