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
 *   - app  capability  → bound here (only the verbs that need a host-reaching
 *                        execute are wired in increment 1: `index`).
 */

const { logAudit } = require('../governance/audit');

/**
 * Build the `deps` bundle for runGovernedAction.
 * @param {Object}   p
 * @param {Function} [p.pinChallenge]      async (ctx, { echo }) => boolean
 * @param {Function} [p.confirmChallenge]  async (ctx, echo)     => boolean
 * @param {Function} [p.floorPolicy]       bareguard Axis-A policy: async (toolName, args, ctx) => true|denyString
 * @param {string[]} [p.denylist]          command denylist (shell severity classifier)
 * @param {Object}   [p.indexer]           litectx policy wrapper (for the `index` verb)
 */
function buildGovernDeps({ pinChallenge, confirmChallenge, floorPolicy, denylist = [], indexer } = {}) {
  return {
    pinChallenge,
    confirmChallenge,
    denylist,
    floor: makeFloor({ floorPolicy }),
    execute: makeExecute({ indexer }),
    audit: async (intentLine, meta = {}) => {
      logAudit({
        action: 'govern',
        intent: intentLine,
        capability: meta.capability,
        tier: meta.tier,
        user_id: meta.ctx?.senderId,
        chatId: meta.ctx?.chatId,
        platform: meta.ctx?.platform,
        status: 'executed',
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
  if (!floorPolicy) return undefined;
  return async function floor(cap, args, ctx) {
    if (cap.kind !== 'host' || !cap.tool) return true; // not a bareguard-governed call
    return floorPolicy(cap.tool.name, args, ctx);
  };
}

/** The single execution dispatcher: capability descriptor + concrete args → result. */
function makeExecute({ indexer } = {}) {
  return async function execute(cap, args, ctx) {
    // Host capabilities carry their source tool definition — reuse its execute
    // verbatim (governance now lives in the core wrapping this call, not the tool).
    if (cap.kind === 'host') {
      return cap.tool.execute(args, ctx);
    }
    // App-verbs whose execution reaches the host are bound explicitly.
    switch (cap.name) {
      case 'index': {
        // Registry scope vocab: 'kb' = the public KB, 'admin' = owner-private.
        // indexFile's role vocab is 'public' | 'admin'.
        const role = args.scope === 'admin' ? 'admin' : 'public';
        const count = await indexer.indexFile(args.path, role);
        return { count, path: args.path, role };
      }
      default:
        throw new Error(`No execute bound for app capability: ${cap.name}`);
    }
  };
}

module.exports = { buildGovernDeps, makeExecute };
