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
  return `A user just saved a NEW note. Decide if it UPDATES one of their existing facts, or is a NEW fact.

UPDATE <n>: the new note is about the SAME subject as existing fact <n> and revises its value, so the old value is now obsolete. This includes BOTH explicit changes ("moved", "now", "actually", "changed") AND a plain new value for a SINGULAR attribute the user has only one of (their weight, their wedding date, their flight time, their address, their job, their deadline). Pick the single best-matching fact.

NEW: no existing fact is about the same subject — a different subject is always NEW even if a day/number coincides ("my X" vs "my sister's X" differ; "my wedding" vs "my meeting" differ). Also choose NEW if you genuinely can't tell whether it's the same subject (keeping both is safer than wrongly overwriting).

EXISTING facts:
${list}

NEW note:
  ${note}

Reply with ONLY "UPDATE <n>" or "NEW". No other text.`;
}

/**
 * Parse the model's reply into a 1-based index (UPDATE) or null (NEW). Fail-toward-keep: an explicit
 * NEW wins even if a stray digit is also present (a reply like "NEW, not 1" must NOT merge — a
 * false-merge is the dangerous direction); otherwise the first integer (`UPDATE 2` or a bare `2`),
 * else null. Range validation is the caller's.
 */
function parseChoice(raw) {
  const t = String(raw || '').trim();
  if (/\bnew\b/i.test(t)) return null; // NEW wins ties → never a false-merge on an ambiguous reply
  const num = t.match(/\d+/);
  return num ? parseInt(num[0], 10) : null; // "UPDATE <n>" / bare number → that index; nothing → keep
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
 *
 * `supersededText` (the overwritten fact's prior value) is returned so the caller can SHOW what it
 * replaced ("…was: X") — auto-update + tell-me (owner decision 2026-06-28): no confirm dialog, but
 * every overwrite is surfaced with its old value, so a wrong auto-update is visible and recoverable
 * (re-`/remember` the old value) rather than a silent destroy.
 * @returns {Promise<{id:string|null, superseded:boolean, supersededText:string|null}>}
 */
async function rememberWithSupersede({ indexer, provider, scope, note, memCfg = {} }) {
  let id = null, supersededText = null;
  // The judge is strictly additive — fail-toward-keep. Disabled / no provider skips it; and ANY error
  // in the candidate-fetch or judgment degrades to a plain new-fact write so a deliberate note is NEVER
  // dropped (a transient recall failure must not lose the write — the rememberFact below is the single,
  // always-reached write path).
  if (memCfg.supersede !== false && provider) {
    try {
      const candidates = await indexer.factCandidates(scope, note, { n: memCfg.supersede_candidates ?? 5 });
      id = await resolveSupersedeId({ provider, candidates, note });
      if (id) {
        const prior = candidates.find((c) => c.id === id)?.text ?? null; // capture BEFORE the overwrite
        // Only report a supersede when the prior value actually CHANGED. Re-saving an identical fact
        // still upserts the same row (no duplicate) but is a no-op to the user, so it reads as a plain
        // "Noted." rather than the misleading "updated (was: <the same text>)".
        if (prior != null && prior.trim().toLowerCase() !== String(note).trim().toLowerCase()) supersededText = prior;
      }
    } catch {
      id = null;
    }
  }
  await indexer.rememberFact(scope, note, { by: 'human', id });
  return { id, superseded: !!id, supersededText };
}

module.exports = { resolveSupersedeId, rememberWithSupersede, buildPrompt, parseChoice };
