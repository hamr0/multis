'use strict';
/**
 * src/memory/supersede.js — W4 same-subject supersession for `/remember` (litectx 0.24.0).
 *
 * litectx 0.24.0 made `remember(id, …)` a tenant-fenced upsert by `(scope, id)`: re-asserting the
 * SAME id under the SAME scope replaces the value in place. litectx delivers the keyed-write
 * MECHANIC; deciding "this new fact RESTATES-AND-UPDATES an existing one (so overwrite it) vs is a
 * distinct fact (so keep both)" is the consumer's job — that judgment lives here.
 *
 * The judge is an LLM call. Two invariants make it safe to wield over the user's durable memory:
 *   1. Fail toward KEEPING — any uncertainty, parse miss, or LLM error returns null → a brand-new
 *      fact is written, nothing is overwritten. A false-merge (overwriting a still-true fact) is the
 *      worst outcome, so every ambiguous path degrades to "pile up", never to "destroy".
 *   2. Scope-fenced blast radius — candidates come from a scope-bound recall, so even a wrong merge
 *      can only ever touch THIS tenant's own memory, never another's (the litectx fence holds
 *      independently of the judge).
 *
 * Candidates are shown to the model under short numeric labels (1, 2, …), not their raw ids — a
 * model reproduces "2" far more reliably than a `mem-1719…-3` id verbatim. We map the label back to
 * the real id, so an out-of-range or hallucinated answer simply fails the range check → null.
 *
 * NOTE: the instruction goes in the USER message, not `system` — multis's `simpleGenerate` forwards
 * `system` as a provider option, which bare-agent's providers ignore (a no-op), so a system prompt
 * here would be silently dropped. (POC-confirmed against the configured provider.)
 */
const { simpleGenerate } = require('../llm/provider-adapter');

/** Build the user-channel judge prompt. `candidates` are shown under 1-based numeric labels. */
function buildPrompt(note, candidates) {
  const list = candidates.map((c, i) => `  ${i + 1}: ${c.text}`).join('\n');
  return `Decide whether a NEW memory RESTATES-AND-UPDATES one of the user's EXISTING memories.

Pick an existing number ONLY when the new memory asserts the SAME attribute of the SAME subject as that memory, so the old value is now WRONG and must be replaced (a changed deadline, a corrected fact, an updated address/job/phone).

Answer NONE when:
- the new memory is about a DIFFERENT subject (e.g. "my sister" vs "I"), even if the attribute type matches
- it is a DIFFERENT attribute of the same subject (job vs coffee preference) — these COEXIST
- it is a distinct event/fact that contradicts nothing
- you are not confident the old value becomes wrong
When in doubt, answer NONE. Overwriting a still-true memory is the worst outcome.

EXISTING memories:
${list}

NEW memory:
  ${note}

Reply with ONLY the number of the existing memory it replaces (e.g. 2), or the word NONE. No other text.`;
}

/**
 * Parse the model's reply into a 1-based index, or null. Fail-toward-keep: an explicit NONE wins even
 * if a stray digit is also present (a reply like "1st, but NONE" must NOT merge — a false-merge is the
 * dangerous direction), then the first integer, else null. Range validation is the caller's.
 */
function parseChoice(raw) {
  const t = String(raw || '').trim();
  if (/\bnone\b/i.test(t)) return null; // NONE wins ties → never a false-merge on an ambiguous reply
  const num = t.match(/\d+/);
  return num ? parseInt(num[0], 10) : null; // no number and no NONE → keep (fail safe)
}

/**
 * Decide which existing fact id (if any) a new note supersedes.
 * @param {object} a
 * @param {object} a.provider  a bare-agent provider (raw — wrapped with simpleGenerate here)
 * @param {Array<{id:string,text:string}>} a.candidates  scope-fenced existing facts
 * @param {string} a.note  the new fact text
 * @returns {Promise<string|null>}  an existing id to overwrite, or null to write a new fact
 */
async function resolveSupersedeId({ provider, candidates, note }) {
  if (!provider || !Array.isArray(candidates) || candidates.length === 0) return null;
  try {
    const reply = await simpleGenerate(provider).generate(buildPrompt(note, candidates), {
      temperature: 0,
      maxTokens: 15,
    });
    const choice = parseChoice(reply);
    if (choice == null || choice < 1 || choice > candidates.length) return null; // NONE / out-of-range → keep
    return candidates[choice - 1].id;
  } catch {
    return null; // LLM error → never destroy; write a new fact
  }
}

/**
 * Write a durable human fact, superseding an existing same-subject fact in place when the judge
 * finds one (W4). The single orchestration both `/remember` doors (slash app-verb + LLM tool) call,
 * so the policy can't drift between them. Degrades to a plain new-fact write — byte-identical to the
 * pre-W4 behavior — when superseding is disabled (`memCfg.supersede === false`) or no provider is
 * available (e.g. a context with no LLM), so the judge is strictly additive and never load-bearing
 * for the write itself.
 * @returns {Promise<{id:string|null, superseded:boolean}>}  id = the overwritten fact id (else null)
 */
async function rememberWithSupersede({ indexer, provider, scope, note, memCfg = {} }) {
  let id = null;
  // The judge is strictly additive — fail-toward-keep. Disabled / no provider skips it; and ANY error
  // in the candidate-fetch or judgment degrades to a plain new-fact write so a deliberate note is NEVER
  // dropped (a transient recall failure must not lose the write — the rememberFact below is the single,
  // always-reached write path).
  if (memCfg.supersede !== false && provider) {
    try {
      const candidates = await indexer.factCandidates(scope, note, { n: memCfg.supersede_candidates ?? 5 });
      id = await resolveSupersedeId({ provider, candidates, note });
    } catch {
      id = null;
    }
  }
  await indexer.rememberFact(scope, note, { by: 'human', id });
  return { id, superseded: !!id };
}

module.exports = { resolveSupersedeId, rememberWithSupersede, buildPrompt, parseChoice };
