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
// multis-specific prompt-injection patterns. Escalated to the human via
// content.askPatterns (humanChannel decides). COMPOSED with bareguard's
// SAFE_DEFAULT_ASK_PATTERNS — never replacing them (bareguard treats a set
// askPatterns as a full override).
const INJECTION_ASK_PATTERNS = [
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
];

// multis tool name → bareguard canonical action type. Mirrors makeActionTranslator
// so an "always ask" declared on tool names lands on the type the gate evaluates.
const TOOL_TYPE = { exec: 'bash', read_file: 'read', send_file: 'read', grep_files: 'read', find_files: 'read' };

// Command governance tiers (2026-06-17, owner-authorized — see dispatch-rewrite-
// decision). The owner has full machine access, so commands "follow bareguard by
// default" (benign/allowlisted just run); only DESTRUCTIVE commands need a PIN,
// and a tiny CATASTROPHIC set needs PIN **plus** a typed CONFIRM. Reads/finds are
// benign (no PIN) now that the fs scope is open.
//
// Catastrophic = genuine machine-wreckers. Checked before "destructive"; this set
// is deliberately small and explicit so ordinary deletes/moves only hit the PIN
// tier. PIN + typed CONFIRM (never a hard block — the owner can still do it
// deliberately).
//
// INTERIM, LINUX-ONLY — pending bareguard command-severity classification (PRD §7
// ask, filed 2026-06-17). This is the CONSUMER half done right (the severity→
// ceremony mapping is multis policy and stays here), but the cross-platform
// CLASSIFICATION (macOS `diskutil eraseDisk`, Windows `format`/`diskpart`/
// `Remove-Item -Recurse -Force`) belongs in the lib. When bareguard ships
// `classifyCommand`, replace this block with the lib call — the tier→PIN/CONFIRM
// mapping below is unchanged. Do NOT grow a parallel macOS/Windows list here.
const CATASTROPHIC_RM = /\brm\b[^|;&\n]*?(?:-\w*r\w*\b[^|;&\n]*?-\w*f|\b-\w*f\w*\b[^|;&\n]*?-\w*r|-\w*(?:rf|fr)\w*)/i;
const CATASTROPHIC_ROOT_TARGET = /(?:^|\s)(?:\/|\/\*|~\/?|\$HOME)(?:\s|$|\/|\*)/;
const CATASTROPHIC_PATTERNS = [
  /\bdd\b[^\n]*\bof=\/dev\//i,                 // dd writing to a raw device
  /\bmkfs\S*/i,                                // make a filesystem
  /\bwipefs\b/i,
  />\s*\/dev\/(?:sd|nvme|vd|mmcblk|disk)/i,     // redirect over a block device
  /:\s*\(\s*\)\s*\{/,                          // fork bomb  :(){ :|:& };:
  /\b(?:shutdown|reboot|poweroff|halt)\b/i,     // power state
  /\binit\s+[06]\b/i,
];
function isCatastrophic(cmd) {
  const c = String(cmd || '');
  if (CATASTROPHIC_RM.test(c) && CATASTROPHIC_ROOT_TARGET.test(c)) return true;
  return CATASTROPHIC_PATTERNS.some((re) => re.test(c));
}

// First executable token of a command (skips leading `sudo`/`env` and a path).
function commandHead(cmd) {
  const toks = String(cmd || '').trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^(?:sudo|env)$/i.test(toks[i])) i++;
  const head = (toks[i] || '').split('/').pop();
  return head.toLowerCase();
}
// Destructive = the governance denylist (rm/mv-class, chmod, kill, …) + `sudo`
// itself. PIN-gated (runs after a correct PIN).
function makeDestructiveCheck(denylist) {
  const set = new Set((denylist || []).map((c) => String(c).toLowerCase()));
  return (cmd) => set.has('sudo') && /^\s*sudo\b/i.test(cmd) ? true : set.has(commandHead(cmd));
}

/**
 * @param {object} args
 * @param {RegExp[]} [args.safeAskPatterns]  bareguard's SAFE_DEFAULT_ASK_PATTERNS,
 *   passed in by createGate (ESM, async-loaded). Defaults to [] for the pure
 *   sync test accessor — production composes the real defaults.
 */
function buildGateConfig({ governance, security, audit, budget, llm, safeAskPatterns = [] }) {
  const cfg = {};

  if (governance?.commands) {
    // bash.allow = the commands PERMITTED to run = allowlist (benign) ∪ denylist
    // (destructive, permitted *after* ceremony). The denylist's role is SEVERITY
    // CLASSIFICATION (→ PIN / PIN+CONFIRM in the M9 core), NOT permission — so its
    // commands must pass this floor to *reach* the ceremony. A command in NEITHER
    // list (e.g. `make`, `docker`) stays unpermitted → the floor denies it. Without
    // the union, a destructive command is walled at the floor and never ceremonies
    // (the bug that silently broke the slash door's destructive path). The core
    // reads the raw denylist (surfaced separately) to classify; this union only
    // governs floor-admission.
    const allowlist = governance.commands.allowlist || [];
    const denylist = governance.commands.denylist || [];
    cfg.bash = {
      allow: [...allowlist, ...denylist],
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
    // Compose: bareguard safe defaults (delete/revoke/truncate/force-push/…)
    // FIRST, then multis injection patterns. Setting askPatterns is a full
    // override in bareguard, so we must re-include the defaults explicitly.
    askPatterns: [...safeAskPatterns, ...INJECTION_ASK_PATTERNS],
  };

  // Optional "always ask" before a tool runs, via bareguard's flags primitive
  // (fires at eval step 4b — before the allowlist). `checkpoint_tools` are multis
  // tool names mapped to gate types. **Default is now [] (opt-in):** under the
  // obedient command-governance model, benign commands just run and friction is
  // applied per-tier in policy() (destructive→PIN, catastrophic→PIN+CONFIRM), so
  // a blanket yes/no on every exec is no longer the default. Set it to re-enable.
  const askTools = security?.checkpoint_tools ?? [];
  if (askTools.length) {
    const types = {};
    for (const t of askTools) types[TOOL_TYPE[t] || t] = 'ask';
    cfg.flags = { type: types };
  }

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
  const shellTools = new Set(['exec', 'read_file', 'send_file', 'grep_files', 'find_files']);
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
    // Compose multis injection asks ON TOP of bareguard's safe defaults rather
    // than clobbering them (bareguard treats a set askPatterns as a full override).
    safeAskPatterns: bareguard.SAFE_DEFAULT_ASK_PATTERNS || [],
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

  // Severity classification (destructive/catastrophic) moved to the M9 core
  // (classifyEffectiveSeverity); the gate keeps only the deterministic Axis-A floor.
  const recordDeny = async (toolName, args, ctx, phase, reason) => {
    try {
      const action = makeActionTranslator(defaultTranslator)(toolName, args, ctx);
      await gate.record(action, { phase, reason });
    } catch { /* audit write must not break the deny path */ }
  };

  // Thin Axis-A floor (M9 increment 3). The exec severity CEREMONY (PIN /
  // PIN+CONFIRM) used to live here, ahead of wireGate.policy; it now lives ONCE in
  // the M9 governed core (runGovernedAction), reached by the LLM door via the
  // wrapped tool execute and by the slash door directly — so both doors ceremony
  // through the same code. This policy is what bare-agent's Loop calls before each
  // tool: it keeps only the deterministic floor — the owner-bypass (non-owners get
  // no shell tool) + wireGate.policy (bareguard's allowlist/fs.deny/content/secrets/
  // budget + the maxToolRounds HaltError). Because bash.allow now ∪ the denylist, a
  // destructive command PASSES this floor (not walled) and the core's classifier +
  // ceremony gate it on execute. wireGate.policy throws HaltError on halt severity
  // (caught by Loop) and returns deny strings verbatim on action severity.
  // Non-owner attempts are recorded so a denial isn't silent.
  const policy = async (toolName, args, ctx) => {
    const ownerDeny = ownerCheck(toolName, ctx);
    if (ownerDeny) {
      await recordDeny(toolName, args, ctx, 'denied-owner', ownerDeny);
      return ownerDeny;
    }
    return wired.policy(toolName, args, ctx);
  };

  return {
    gate,
    policy,
    // Axis-A only — bareguard's deterministic floor (allowlist/denylist, fs.deny,
    // content patterns, budget, always-ask flags), WITHOUT the multis owner-check
    // or exec 3-tier ceremony that `policy` composes on top. The M9 governed core
    // runs this as its `floor` dep so the slash door enforces the same boundary the
    // LLM door gets, while the ceremony lives once in the core (no double-ceremony).
    floorPolicy: wired.policy,
    onLlmResult: wired.onLlmResult,
    onToolResult: wired.onToolResult,
    filterTools: wired.filterTools,
    // The command denylist drives the M9 core's shell-severity classifier
    // (classifyEffectiveSeverity → makeDestructiveCheck). Surface it here so the
    // single governed core reads the SAME list the LLM-path 3-tier already uses.
    denylist: governance?.commands?.denylist || [],
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
  isCatastrophic,
  commandHead,
  makeDestructiveCheck,
};
