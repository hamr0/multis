/**
 * runGovernedAction (M9 — the one governed core, PRD §F).
 *
 * The ONLY place auth / ceremony / audit happen. Both surfaces — the slash app-verbs
 * and the natural-language/LLM path — resolve to a declared capability (registry.js)
 * and run it through here. The flow:
 *
 *   floor (owner-only) → arg-validation (missing/placeholder → picker)
 *     → classify effective severity → catastrophic = hard WALL; destructive = PIN
 *       ceremony (verbatim-arg echo); benign = run
 *     → execute → record plain-language intent → return an UNAMBIGUOUS result.
 *
 * Return contract (fixes the dead-3-tier bug, PRD §F / M9 "known bug"): an explicit
 * tagged object, NEVER the old `null`-means-allow. The old policy returned `null` on a
 * cleared ceremony, which `enforceGate` read as allow but bare-agent's `Loop`
 * (`verdict !== true`) read as DENY — so a destructive action was denied even after a
 * correct PIN. Here a cleared destructive action returns `{ ok: true, result }`; both
 * consumers map their own verdict off `.ok`. Proven by a consumer-level test (govern.test.js).
 *
 * Pure orchestration: all I/O is injected via `deps` (pinChallenge, execute, audit)
 * so it is testable without the bot stack and so the ceremony seam stays
 * single-sourced in human-channel.js.
 */

const {
  getCapability,
  classifyEffectiveSeverity,
  requiresCeremony,
  SEVERITY,
} = require('./registry');

/** Result kinds — an explicit contract, never null-means-allow. */
const RESULT = Object.freeze({
  OK: 'ok',                 // ran; carries result
  NEEDS_ARG: 'needs_arg',   // missing/invalid required arg → caller opens the picker
  DENIED: 'denied',         // floor or declined ceremony
  UNKNOWN: 'unknown',       // no such capability
});

/**
 * @param {Object}   p
 * @param {Object|string} p.capability  a capability descriptor or its name/alias
 * @param {Object}   p.args             concrete arguments
 * @param {Object}   p.ctx              { isOwner, platform, chatId, senderId, ... }
 * @param {Object}   p.deps
 * @param {Function} [p.deps.pinChallenge]      async (ctx, { echo }) => boolean
 * @param {Function} p.deps.execute             async (cap, args, ctx) => any  (REQUIRED)
 * @param {Function} [p.deps.floor]             async (cap, args, ctx) => true|denyString — Axis-A
 * @param {Function} [p.deps.audit]             async (intentLine, meta) => void
 * @param {string[]} [p.deps.denylist]          governance command denylist (shell tier)
 * @returns {Promise<{kind, ok, tier?, result?, reason?, missing?, echo?}>}
 */
async function runGovernedAction({ capability, args = {}, ctx = {}, deps = {} }) {
  const cap = typeof capability === 'string' ? getCapability(capability) : capability;
  if (!cap) return { kind: RESULT.UNKNOWN, ok: false, reason: 'unknown_capability' };

  // 1. Floor — the single owner boundary (was split across registry + gate ownerCheck).
  //    This returns BEFORE deps.floor (bareguard), so a denied attempt would otherwise
  //    reach neither audit.log nor gate.jsonl — a non-owner probing host verbs left no
  //    trace (M9 LIVE‡ owner-flip finding). Record it; the boundary already holds.
  if (cap.ownerOnly && !ctx.isOwner) {
    if (deps.audit) await deps.audit(plainIntent(cap, args, 'denied'), { capability: cap.name, ctx, status: 'denied-owner' }).catch(() => {});
    return { kind: RESULT.DENIED, ok: false, reason: 'owner_only' };
  }

  // 2. Arg-validation against the capability schema. The model hallucinates missing
  //    args (POC finding #1: "set it to silent" → target=owner) — never trust it to
  //    leave a blank; validate here and route a gap to the picker.
  const v = validateArgs(cap, args);
  if (!v.ok) {
    return { kind: RESULT.NEEDS_ARG, ok: false, reason: 'missing_args', missing: v.missing };
  }

  // 2.5 Axis-A — the deterministic floor (bareguard's 13 primitives: command
  //     allowlist/denylist, fs.deny, content patterns, budget, always-ask flags).
  //     The boundary that can't be talked past, so it runs BEFORE classify/ceremony
  //     — no point PINning an action the floor hard-denies. Single-sourced here for
  //     both doors. Returns true (allow) or a deny string the caller surfaces.
  if (deps.floor) {
    const verdict = await deps.floor(cap, args, ctx);
    if (verdict !== true) {
      // Audit parity: like denied-owner above, a floor deny must leave an
      // audit.log trace. The slash door's bareguard policy also records it to
      // gate.jsonl; this keeps both logs in sync so a denied attempt is never
      // invisible to an audit.log reader.
      if (deps.audit) await deps.audit(plainIntent(cap, args, 'denied'), { capability: cap.name, ctx, status: 'denied-floor' }).catch(() => {});
      return { kind: RESULT.DENIED, ok: false, reason: 'floor', message: typeof verdict === 'string' ? verdict : undefined };
    }
  }

  // 3. Effective severity (shell resolves from the command string; set_mode(off) escalates).
  const tier = classifyEffectiveSeverity(cap, args, deps.denylist);

  // 4. Wall / ceremony — verbatim-arg echo so the owner approves the RESOLVED action,
  //    not the intent (POC finding #2: run_shell args are fabricated).
  const echo = echoArgs(cap, args);
  // Catastrophic = a permanent WALL. Machine-wreckers (rm -rf of a root/home target,
  // dd to a device, mkfs, fork bomb, shutdown) NEVER run through the bot — no PIN, no
  // CONFIRM, no override; the owner uses a real terminal for those. There is no
  // legitimate automation need, and the negative POC showed the model is hijackable —
  // so the strongest catch (a wall) beats a ceremony here. bareguard's content floor
  // independently denies `rm -rf /…` too; this multis-owned half also covers the
  // shapes that slip past it (`rm -rf ~/*`, `dd`, `mkfs`, …).
  if (tier === SEVERITY.CATASTROPHIC) {
    if (deps.audit) await deps.audit(plainIntent(cap, args, tier), { capability: cap.name, tier, ctx, blocked: true }).catch(() => {});
    return { kind: RESULT.DENIED, ok: false, reason: 'catastrophic_blocked', tier, echo };
  }
  // Destructive = a PIN speed bump (the owner clears it and proceeds).
  if (requiresCeremony(tier)) {
    const cleared = await runCeremony({ ctx, echo, deps });
    if (!cleared) {
      if (deps.audit) await deps.audit(plainIntent(cap, args, tier), { capability: cap.name, tier, ctx, status: 'denied-ceremony' }).catch(() => {});
      return { kind: RESULT.DENIED, ok: false, reason: `${tier}_ceremony_declined`, tier, echo };
    }
  }

  // 5. Execute.
  const result = await deps.execute(cap, args, ctx);

  // 6. Record the plain-language intent on every action.
  if (deps.audit) {
    await deps.audit(plainIntent(cap, args, tier), { capability: cap.name, tier, ctx }).catch(() => {});
  }

  // 7. The real allow signal — `{ ok: true }`, never null.
  return { kind: RESULT.OK, ok: true, tier, result, echo };
}

/** Run the destructive tier's ceremony: a PIN speed bump. (Catastrophic never reaches
 *  here — it is walled in step 4. Benign never reaches here either.) */
async function runCeremony({ ctx, echo, deps }) {
  if (deps.pinChallenge) {
    const pinOk = await deps.pinChallenge(ctx, { echo });
    if (!pinOk) return false;
  }
  return true;
}

/**
 * Validate concrete args against a capability's declared schema.
 * A required arg that is absent, blank, placeholder-looking, or an out-of-enum value
 * is a GAP → the caller opens the picker. (We don't trust the model to signal a blank.)
 */
function validateArgs(cap, args = {}) {
  if (!cap.args) return { ok: true };
  const required = cap.args.required || [];
  const props = cap.args.properties || {};
  const missing = [];

  for (const key of required) {
    const val = args[key];
    if (val === undefined || val === null || String(val).trim() === '' || looksLikePlaceholder(String(val))) {
      missing.push(key);
    }
  }
  // An enum value the model invented (not in the declared set) is also a gap.
  for (const [key, spec] of Object.entries(props)) {
    if (spec.enum && args[key] !== undefined && !spec.enum.includes(args[key]) && !missing.includes(key)) {
      missing.push(key);
    }
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}

/** Obvious fabricated placeholders the model emits when it has no real value. */
function looksLikePlaceholder(v) {
  return /\/path\/to\/|^<.+>$|\bYOUR_|\bplaceholder\b|\/cache\/folder\b/i.test(v);
}

/** The verbatim string the owner sees at the ceremony — the RESOLVED action, not the ask. */
function echoArgs(cap, args = {}) {
  if (cap.scope === 'host.shell') return String(args.command ?? args.cmd ?? '');
  const required = (cap.args && cap.args.required) || Object.keys(args);
  const parts = required.map((k) => `${k}=${args[k]}`);
  return `${cap.name}(${parts.join(', ')})`;
}

/** Plain-language intent recorded on every action. */
function plainIntent(cap, args, tier) {
  return `[${tier}] ${cap.name}: ${echoArgs(cap, args)}`;
}

module.exports = {
  runGovernedAction,
  validateArgs,
  echoArgs,
  RESULT,
};
