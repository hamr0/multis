/**
 * Capability registry (M9 — intent-first dispatch, PRD §F).
 *
 * THE single vocabulary both surfaces resolve to: the slash app-verbs AND the
 * natural-language/LLM path select a *declared capability* here — never free shell.
 * Each capability declares { args, scope, severity }. `runGovernedAction` (step 2)
 * is the only consumer; it classifies → ceremonies → runs → records from these
 * descriptors. This module is data + pure helpers — no I/O, no execution.
 *
 * Two kinds:
 *   - 'host'  : wraps an existing tool in src/tools/definitions.js (reuses its
 *               execute + input_schema; we only add scope/severity/ownerOnly).
 *   - 'app'   : a curated app-verb (/status, /mode, /index …). Execute wiring is
 *               bound in runGovernedAction; here we declare the descriptor.
 *
 * Severity is DECLARED per capability (not inferred from a command string), except
 * the shell capability whose arg *is* a command — it carries `severity:'dynamic:shell'`
 * and is resolved per-invocation by the existing 3-tier gate classifiers. The
 * negative-POC invariant (2026-06-19) holds here: a destructive/catastrophic effective
 * severity ALWAYS requires ceremony — no host capability may bypass it.
 *
 * Deliberately ABSENT: raw `/exec` and `/read` as app-verbs. Host shell/read reach
 * the machine only through the governed host capabilities run_shell / read_file.
 */

const { TOOLS } = require('../tools/definitions');
const { FORCE_OWNER_ONLY, DEFAULT_OWNER_ONLY } = require('../tools/registry');
const { classifyShellSeverity, matchesAskEscalation } = require('../governance/gate');

const SEVERITY = Object.freeze({
  BENIGN: 'benign',
  DESTRUCTIVE: 'destructive',
  CATASTROPHIC: 'catastrophic',
});
const SHELL_DYNAMIC = 'dynamic:shell';
const TIER_RANK = { benign: 0, destructive: 1, catastrophic: 2 };

/**
 * Per-host-tool scope + declared severity (single source). `rename` retargets the
 * tool's registry name to its capability name (exec → run_shell). Anything not listed
 * defaults to a benign host-desktop capability so a newly added tool fails *safe-by-UX*
 * (benign) but is still owner-gated by the floor — flag new destructive tools here.
 */
const HOST_META = {
  exec:          { rename: 'run_shell', scope: 'host.shell',   severity: SHELL_DYNAMIC },
  read_file:     { scope: 'host.fs.read',  severity: SEVERITY.BENIGN },
  find_files:    { scope: 'host.fs.read',  severity: SEVERITY.BENIGN },
  grep_files:    { scope: 'host.fs.read',  severity: SEVERITY.BENIGN },
  send_file:     { scope: 'host.fs.read',  severity: SEVERITY.BENIGN },
  search_docs:   { scope: 'kb.read',       severity: SEVERITY.BENIGN },
  recall_memory: { scope: 'memory.read',   severity: SEVERITY.BENIGN },
  remember:      { scope: 'memory.write',  severity: SEVERITY.BENIGN },
  escalate:      { scope: 'escalate',      severity: SEVERITY.BENIGN },
  open_url:      { scope: 'host.desktop',  severity: SEVERITY.BENIGN },
  media_control: { scope: 'host.desktop',  severity: SEVERITY.BENIGN },
  notify:        { scope: 'host.desktop',  severity: SEVERITY.BENIGN },
  clipboard:     { scope: 'host.desktop',  severity: SEVERITY.BENIGN },
  screenshot:    { scope: 'host.desktop',  severity: SEVERITY.BENIGN },
  system_info:   { scope: 'host.read',     severity: SEVERITY.BENIGN },
  wifi:          { scope: 'host.desktop',  severity: SEVERITY.BENIGN },
  brightness:    { scope: 'host.desktop',  severity: SEVERITY.BENIGN },
};

// exec/read_file/find_files/grep_files reach the host FS but were historically
// owner-gated at the bareguard gate (ownerCheck), NOT in the registry floor — a split
// M9 unifies. The capability registry is now the single floor, so it must reflect that
// these reads are owner-only too. (exec/read_file are already in DEFAULT_OWNER_ONLY;
// find_files/grep_files were the gap the registry test surfaced.)
const HOST_OWNER_GATED = new Set(['find_files', 'grep_files']);

/** ownerOnly is single-sourced here: the existing registry floor ∪ the gate-gated reads. */
function ownerOnlyFor(toolName) {
  return FORCE_OWNER_ONLY.has(toolName)
    || HOST_OWNER_GATED.has(toolName)
    || (DEFAULT_OWNER_ONLY[toolName] ?? false);
}

/** Build the 'host' capabilities by wrapping the existing TOOLS. */
function buildHostCapabilities() {
  return TOOLS.map((tool) => {
    const meta = HOST_META[tool.name] || { scope: 'host.desktop', severity: SEVERITY.BENIGN };
    return {
      name: meta.rename || tool.name,
      kind: 'host',
      description: tool.description,
      args: tool.input_schema || null,
      scope: meta.scope,
      severity: meta.severity,
      ownerOnly: ownerOnlyFor(tool.name),
      platforms: tool.platforms,
      tool, // the source definition (carries execute + input_schema)
    };
  });
}

/**
 * Curated app-verbs (slash shortcuts). Each declares its args (a minimal schema or
 * null when it takes none) + scope + severity + ownerOnly. `aliases` lets several
 * slash words (/silent, /business, /off) resolve to one capability with a fixed arg.
 * `platforms` omitted = all platforms.
 *
 * NOTE: raw exec/read are intentionally NOT here (M9 removes the raw-shell front door).
 */
const APP_VERBS = [
  { name: 'status',  scope: 'app.read',   severity: SEVERITY.BENIGN, ownerOnly: false, args: null },
  { name: 'help',    scope: 'app.read',   severity: SEVERITY.BENIGN, ownerOnly: false, args: null },
  { name: 'docs',    scope: 'kb.read',    severity: SEVERITY.BENIGN, ownerOnly: false, args: null },
  { name: 'skills',  scope: 'app.read',   severity: SEVERITY.BENIGN, ownerOnly: false, args: null },
  { name: 'agents',  scope: 'app.read',   severity: SEVERITY.BENIGN, ownerOnly: false, args: null },
  { name: 'jobs',    scope: 'app.read',   severity: SEVERITY.BENIGN, ownerOnly: false, args: null },
  { name: 'search',  scope: 'kb.read',    severity: SEVERITY.BENIGN, ownerOnly: false,
    args: schema({ query: str('What to search for') }, ['query']) },
  { name: 'ask',     scope: 'kb.read',    severity: SEVERITY.BENIGN, ownerOnly: false,
    args: schema({ question: str('The question to answer from context') }, ['question']) },
  { name: 'memory',  scope: 'memory.read', severity: SEVERITY.BENIGN, ownerOnly: false, args: null },
  { name: 'remember', scope: 'memory.write', severity: SEVERITY.BENIGN, ownerOnly: false,
    args: schema({ note: str('The note to remember') }, ['note']) },
  // forget removes durable memory → destructive (ceremony before deletion). `target` is the human
  // label (a topic, or "everything"); the optional `id` is a specific memory row to delete precisely
  // (targeted /forget) — absent → clear the whole scope. `id` is set by the router from a scope-fenced
  // match, never by the model, so it isn't required (the topic path validates on `target`).
  { name: 'forget',  scope: 'memory.write', severity: SEVERITY.DESTRUCTIVE, ownerOnly: false,
    args: schema({ target: str('What memory to forget'), id: str('A specific memory id to delete (targeted forget)') }, ['target']) },
  // set_mode: the single mode capability. mode=off is data-losing (zero I/O incl. no
  // logging) → declared destructive (negative-POC §3: "turn off notifications"→off drift).
  { name: 'set_mode', aliases: ['mode', 'silent', 'business', 'personal', 'off'],
    scope: 'chat.mode', severity: SEVERITY.BENIGN, ownerOnly: false,
    destructiveWhen: (args) => args && args.mode === 'off',
    args: schema({
      target: str('The contact or chat to set the mode for'),
      mode: enumStr(['business', 'personal', 'silent', 'off'], 'The mode to apply'),
    }, ['target', 'mode']) },
  // index reads the host FS into the (world-readable) KB → owner-only entirely.
  { name: 'index',   scope: 'kb.write',   severity: SEVERITY.BENIGN, ownerOnly: true,
    args: schema({
      path: str('Path to the document to index'),
      scope: enumStr(['kb', 'admin'], 'kb=public, admin=owner-private'),
    }, ['path', 'scope']) },
  { name: 'admin',   scope: 'app.admin',  severity: SEVERITY.BENIGN, ownerOnly: true, args: null },
  { name: 'pin',     scope: 'app.auth',   severity: SEVERITY.BENIGN, ownerOnly: false, args: null },
  { name: 'remind',  scope: 'app.schedule', severity: SEVERITY.BENIGN, ownerOnly: false,
    args: schema({ when: str('When to remind'), text: str('Reminder text') }, ['when', 'text']) },
  { name: 'cron',    scope: 'app.schedule', severity: SEVERITY.BENIGN, ownerOnly: true, args: null },
  { name: 'cancel',  scope: 'app.schedule', severity: SEVERITY.BENIGN, ownerOnly: false,
    args: schema({ id: str('The job id to cancel') }, ['id']) },
  { name: 'plan',    scope: 'app.read',   severity: SEVERITY.BENIGN, ownerOnly: false, args: null },
  // NOTE: no `unpair` verb. A paired account is only ever the owner's, so a
  // self-unpair would risk orphaning the bot (no owner left). Full teardown is a
  // CLI action (`multis stop` → rm -rf ~/.multis), not a chat command.
].map((v) => ({ ...v, kind: 'app' }));

// ---- tiny JSON-schema helpers (keep the declarations readable) ----
function str(description) { return { type: 'string', description }; }
function enumStr(values, description) { return { type: 'string', enum: values, description }; }
function schema(properties, required) { return { type: 'object', properties, required }; }

// ---- assemble + index ----
const CAPABILITIES = [...buildHostCapabilities(), ...APP_VERBS];

const BY_NAME = new Map();
// Host capabilities are renamed (exec → run_shell), so the LLM/agent path — which
// only knows the SOURCE tool name (`exec`, `read_file`, …) — needs a reverse map.
const BY_TOOL = new Map();
for (const cap of CAPABILITIES) {
  BY_NAME.set(cap.name, cap);
  for (const alias of cap.aliases || []) BY_NAME.set(alias, cap);
  if (cap.kind === 'host' && cap.tool) BY_TOOL.set(cap.tool.name, cap);
}

/** Look up a capability by name or alias. */
function getCapability(name) {
  return BY_NAME.get(name) || null;
}

/**
 * Look up a HOST capability by its source tool name (exec, read_file, …) — the
 * name the bare-agent Loop calls tools by. Returns null for a tool that isn't a
 * declared capability (it then runs unwrapped on the LLM path).
 */
function getCapabilityForTool(toolName) {
  return BY_TOOL.get(toolName) || null;
}

/**
 * List capabilities visible to a principal on a platform.
 * Owner-only capabilities are hidden from non-owners (the floor). Host capabilities
 * are platform-filtered; app-verbs are platform-agnostic unless they declare platforms.
 */
function listCapabilities({ platform, isOwner } = {}) {
  return CAPABILITIES.filter((cap) => {
    if (cap.ownerOnly && !isOwner) return false;
    if (platform && cap.platforms && !cap.platforms.includes(platform)) return false;
    return true;
  });
}

/**
 * Resolve the EFFECTIVE severity tier for a capability + its concrete args.
 * - 'dynamic:shell'      → run the 3-tier gate classifiers on the command string.
 * - a `destructiveWhen`  → escalates a benign declaration to destructive for some args
 *                          (e.g. set_mode(off)).
 * - otherwise            → the declared static tier.
 * @param {Object} cap     a capability descriptor
 * @param {Object} args    the concrete arguments
 * @param {string[]} [denylist] governance command denylist (for the shell classifier)
 * @returns {'benign'|'destructive'|'catastrophic'}
 */
function classifyEffectiveSeverity(cap, args, denylist) {
  if (!cap) return SEVERITY.BENIGN;
  let tier;
  if (cap.severity === SHELL_DYNAMIC) {
    // Severity classification is bareguard's (classifyCommand) — super→catastrophic,
    // destructive→destructive, safe→benign. The denylist rides in as extraDestructive.
    const command = (args && (args.command ?? args.cmd)) || '';
    tier = classifyShellSeverity(command, denylist || []);
  } else if (cap.destructiveWhen && cap.destructiveWhen(args)) {
    tier = rankUp(cap.severity, SEVERITY.DESTRUCTIVE);
  } else {
    tier = cap.severity;
  }
  // Folded from the removed interactive yes/no ask: a tool call carrying
  // destructive-intent risk-words (delete/drop/truncate/force-push/…) or an
  // injection pattern escalates to the destructive PIN tier — ONE operator gate
  // (park-and-resume) instead of a separate ask that deadlocked Beeper. A
  // catastrophic classification stays a hard wall (never softened to a PIN).
  if (tier !== SEVERITY.CATASTROPHIC && matchesAskEscalation(args || {})) {
    tier = rankUp(tier, SEVERITY.DESTRUCTIVE);
  }
  return tier;
}

/** Returns whichever tier ranks higher. */
function rankUp(a, b) {
  return (TIER_RANK[b] ?? 0) > (TIER_RANK[a] ?? 0) ? b : a;
}

/** Does this effective tier require an operator ceremony (PIN / PIN+CONFIRM)? */
function requiresCeremony(tier) {
  return (TIER_RANK[tier] ?? 0) >= TIER_RANK.destructive;
}

module.exports = {
  SEVERITY,
  CAPABILITIES,
  getCapability,
  getCapabilityForTool,
  listCapabilities,
  classifyEffectiveSeverity,
  requiresCeremony,
  ownerOnlyFor,
};
