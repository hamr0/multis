/**
 * Runtime deps for the M9 governed core (PRD §F).
 *
 * `runGovernedAction` is pure orchestration — all I/O is injected. This module
 * binds the real services (ceremony, execute, audit, denylist) so BOTH doors —
 * the slash app-verbs and (later) the LLM tool path — resolve to the SAME core
 * with the SAME ceremony instances and the SAME execution sites.
 *
 * `execute` is the one place a declared capability actually runs:
 *   - host capability  → its own tool.execute (reuses src/tools/definitions.js)
 *   - app  capability  → `index` is bound here (needs only the injected indexer);
 *                        the config/memory-coupled verbs (set_mode, forget,
 *                        remember, memory) are passed in as a pre-bound `appExec`
 *                        map by the caller, where config/getMem are in scope. That
 *                        keeps this module a pure binder — no import of handlers.js
 *                        (which owns setChatMode) — so there's no circular require.
 */

const { logAudit } = require('../governance/audit');

/**
 * Build the `deps` bundle for runGovernedAction.
 * @param {Object}   p
 * @param {Function} [p.verifyPin]        async (ctx, reply) => { ok, reason? }
 * @param {Function} [p.floorPolicy]       bareguard Axis-A policy: async (toolName, args, ctx) => true|denyString
 * @param {string[]} [p.denylist]          command denylist (shell severity classifier)
 * @param {Object}   [p.indexer]           litectx policy wrapper (for the `index` verb)
 * @param {Object}   [p.appExec]           name → (args, ctx) => result, for the
 *                                          config/memory-coupled app-verbs
 *                                          (set_mode, forget, remember, memory)
 * @param {Function} [p.execute]            override the default executor entirely:
 *                                          async (cap, args, ctx) => result. The
 *                                          LLM door passes this to delegate to the
 *                                          bare-agent-adapted tool (keeping its
 *                                          tool_call audit) instead of calling
 *                                          cap.tool.execute directly.
 */
function buildGovernDeps({ verifyPin, pinConfigured, floorPolicy, denylist = [], indexer, appExec, execute } = {}) {
  return {
    verifyPin,
    pinConfigured,
    denylist,
    floor: makeFloor({ floorPolicy }),
    execute: execute || makeExecute({ indexer, appExec }),
    audit: async (intentLine, meta = {}) => {
      logAudit({
        action: 'govern',
        intent: intentLine,
        capability: meta.capability,
        tier: meta.tier,
        user_id: meta.ctx?.senderId,
        chatId: meta.ctx?.chatId,
        platform: meta.ctx?.platform,
        // The core records a catastrophic WALL (blocked:true) and now also owner /
        // declined-ceremony denials (explicit meta.status) via this same dep — none
        // may read as 'executed'. Honor an explicit status, else reflect blocked/ran.
        status: meta.status || (meta.blocked ? 'blocked' : 'executed'),
      });
    },
  };
}

/**
 * The Axis-A floor dep. bareguard governs host TOOL calls, so the floor maps a
 * host capability back to its source tool name (run_shell → exec) and runs the
 * deterministic policy. App-verbs (set_mode, index, …) don't reach bareguard, so
 * they pass the floor (their boundary is the owner-floor + severity ceremony in
 * the core). Returns true (allow) or a deny string when no policy is wired.
 */
function makeFloor({ floorPolicy } = {}) {
  // No floorPolicy is a DELIBERATE, load-bearing case, not a fail-open gap: the LLM
  // door (wrapToolThroughCore) omits it on purpose because bare-agent's Loop runs
  // the bareguard Axis-A policy UPSTREAM, before the tool executes — flooring again
  // in the core would double-floor. The slash door DOES pass floorPolicy, so both
  // doors are floored (the LLM path just floors upstream). Returning undefined lets
  // the core skip its redundant floor on the LLM path.
  if (!floorPolicy) return undefined;
  return async function floor(cap, args, ctx) {
    if (cap.kind !== 'host' || !cap.tool) return true; // not a bareguard-governed call
    return floorPolicy(cap.tool.name, args, ctx);
  };
}

/** The single execution dispatcher: capability descriptor + concrete args → result. */
function makeExecute({ indexer, appExec = {} } = {}) {
  return async function execute(cap, args, ctx) {
    // Host capabilities carry their source tool definition — reuse its execute
    // verbatim (governance now lives in the core wrapping this call, not the tool).
    if (cap.kind === 'host') {
      return cap.tool.execute(args, ctx);
    }
    // Config/memory-coupled app-verbs are pre-bound by the caller (set_mode,
    // forget, remember, memory) — runs after the core's floor/ceremony.
    if (appExec[cap.name]) {
      return appExec[cap.name](args, ctx);
    }
    // App-verbs whose execution reaches the host are bound explicitly.
    switch (cap.name) {
      case 'index': {
        // Registry scope vocab: 'kb' = the public KB, 'admin' = owner-private.
        // indexFile's role vocab is 'public' | 'admin'.
        const role = args.scope === 'admin' ? 'admin' : 'public';
        const { chunks, mode } = await indexer.indexFile(args.path, role);
        return { count: chunks, mode, path: args.path, role };
      }
      default:
        throw new Error(`No execute bound for app capability: ${cap.name}`);
    }
  };
}

module.exports = { buildGovernDeps, makeExecute };
