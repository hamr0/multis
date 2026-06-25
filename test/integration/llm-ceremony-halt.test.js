/**
 * Regression: LLM-door ceremony must HALT the agent loop, not just park-and-return.
 *
 * The bug (live-reproduced 2026-06-24 on the NL "Delete the file …" path):
 * wrapToolThroughCore parked the ceremony but RETURNED a tool-result string
 * ("I've requested your PIN …"). bare-agent's Loop feeds that back to the model
 * and keeps going. A model that keeps reasoning/re-calling the tool after the
 * park therefore:
 *   - re-prompts for the PIN every round (one "🔒 needs your PIN" per round), and
 *   - burns tool rounds until bareguard's limits.maxToolRounds fires a HaltError,
 *     which runAgentLoop re-throws and the caller leaks to chat as
 *     "LLM error: halt:gate.terminated" + "⚠️ took too many tool steps".
 * The owner's intended action never executes.
 *
 * The fix: parking the ceremony must END the turn (throw HaltError) so the model
 * cannot continue. After that, exactly ONE PIN prompt is sent regardless of what
 * the model "would" have done next, and the parked ceremony resolves on the PIN
 * reply — the same park-and-resume the slash door already proves.
 *
 * This test models the worst case deterministically: a provider that calls `exec`
 * on EVERY round (never finishing). With the bug it hits the round cap and leaks;
 * with the fix the loop halts after the first park.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createMessageRouter } = require('../../src/bot/handlers');
const { createTestEnv, mockPlatform, msg } = require('../helpers/setup');
const { PinManager, hashPin } = require('../../src/security/pin');
const { PendingRegistry } = require('../../src/bot/pending');
const { readAuditLogs } = require('../../src/governance/audit');

const PIN = '1234';
// echo ∈ allowlist ∪ denylist → passes the Axis-A floor, classified DESTRUCTIVE
// (denylist membership) so it triggers the PIN ceremony; running it is harmless.
const GOV = { commands: { allowlist: ['echo'], denylist: ['echo'] }, paths: { allowed: ['.*'], denied: [] } };
// NB: 'echo repro-marker' — deliberately avoids 'halt'/'shutdown'/'rm -rf ~' words
// that classify CATASTROPHIC (which hard-walls, NOT the destructive PIN ceremony we
// want to exercise). echo ∈ denylist → DESTRUCTIVE → PIN ceremony.
const COMMAND = 'echo repro-marker';

const flush = () => new Promise((r) => setImmediate(r));
async function waitFor(pred, label, tries = 500) {
  for (let i = 0; i < tries; i++) { if (pred()) return; await flush(); }
  throw new Error(`waitFor timed out: ${label}`);
}

function execStub(ran) {
  return {
    name: 'exec', description: 'Run a shell command', platforms: ['linux'], owner_only: true,
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (args) => { ran.push(args.command); return `ran: ${args.command}`; },
  };
}

// A provider that NEVER stops calling `exec` — the worst-case model that keeps
// going after the park. maxToolRounds defaults to 5, so 10 is comfortably past it.
function relentlessExecProvider() {
  const calls = [];
  return {
    calls,
    generate: async (messages, tools, options) => {
      calls.push({ messages, options });
      return {
        text: '',
        toolCalls: [{ id: `t${calls.length}`, name: 'exec', arguments: { command: COMMAND } }],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

function buildLLM(ran) {
  const env = createTestEnv({
    allowed_users: ['user1'], owner_id: 'user1',
    security: { pin_hash: hashPin(PIN), pin_timeout_hours: 24, checkpoint_tools: [] },
  });
  const platform = mockPlatform();
  const pinManager = new PinManager(env.config); pinManager.sessions = {};
  const provider = relentlessExecProvider();
  const router = createMessageRouter(env.config, {
    provider, indexer: { search: () => [], indexFile: async () => 0, indexBuffer: async () => 0,
      getStats: () => ({ indexedFiles: 0, totalChunks: 0, byType: {} }), store: { recordSearchAccess: () => {} } },
    tools: [execStub(ran)], toolsConfig: {}, runtimePlatform: 'linux',
    pinManager, pending: new PendingRegistry(), fileless: true, governanceFile: GOV,
  });
  router.registerPlatform('telegram', platform);
  return { env, platform, router, provider, pinManager };
}

const pinPrompts = (p) => p.sent.filter((s) => /needs your PIN|Reply with your PIN/i.test(s.text));
const lockedNotices = (p) => p.sent.filter((s) => /Locked out/i.test(s.text));

describe('LLM-door ceremony halts the loop (no round-cap leak)', () => {
  it('parks ONCE and never leaks a round-cap halt, even when the model keeps calling', async () => {
    const ran = [];
    const { platform, router, provider } = buildLLM(ran);

    const p = router(msg('/ask delete the scratch file'), platform);
    await waitFor(() => pinPrompts(platform).length > 0, 'first PIN prompt');
    await p;

    // 1. Exactly ONE PIN prompt — the park ended the turn, so the model never got
    //    a second round to re-prompt or re-call.
    assert.strictEqual(pinPrompts(platform).length, 1,
      `expected exactly one PIN prompt, got ${pinPrompts(platform).length} (loop kept running after the park)`);

    // 2. The provider was called at most twice (the round that called exec; the
    //    loop halted instead of grinding to the round cap).
    assert.ok(provider.calls.length <= 2,
      `loop should halt at the park, but the provider ran ${provider.calls.length} rounds`);

    // 3. No round-cap halt leaked to chat (neither the friendly cap message nor the
    //    raw "halt:" error).
    assert.ok(!platform.sent.some((s) => /too many tool steps|halt:/i.test(s.text)),
      `a round-cap halt leaked to chat: ${JSON.stringify(platform.sent.map((s) => s.text))}`);

    // 3b. The clean ceremony-park halt is NOT logged as a loop_error — it's a
    //     governance exit, not a failure (audit fidelity; regression 2026-06-24).
    assert.ok(!readAuditLogs(200).some((e) => e.action === 'loop_error'),
      'a parked ceremony must not write a loop_error audit entry');

    // 4. Nothing executed before the PIN.
    assert.deepStrictEqual(ran, [], 'command must not run before the PIN');

    // 5. The ceremony is parked → the correct PIN resolves it and runs exactly once.
    await router(msg(PIN), platform);
    assert.deepStrictEqual(ran, [COMMAND], 'the correct PIN runs the parked command exactly once');
  });
});

describe('LLM-door ceremony: a locked-out owner gets ONE notice, no double message', () => {
  it('a locked ceremony HALTS with a single "Locked out" line (no model re-narration)', async () => {
    // Regression (live-surfaced 2026-06-25): the locked path RETURNED a tool-result
    // string, so the Loop fed it back and the model RE-NARRATED it — owner saw the
    // canned "Locked out…" AND a paraphrase. With the relentless provider the old
    // behavior also re-prompts every round to the cap. The fix HALTS (like the parked
    // path), so the canned notice ceremonyPrompt already sent is the ONLY message.
    const ran = [];
    const { platform, router, pinManager } = buildLLM(ran);
    // Pre-lock the owner: 3 failed attempts, locked for an hour.
    pinManager.failCounts.set('user1', { count: 3, lockedUntil: Date.now() + 3600_000 });

    const p = router(msg('/ask delete the scratch file'), platform);
    await waitFor(() => lockedNotices(platform).length > 0, 'locked-out notice');
    await p;

    // Exactly ONE "Locked out" message — the loop halted, so the model never ran
    // another round to re-prompt or re-narrate.
    assert.strictEqual(lockedNotices(platform).length, 1,
      `expected exactly one "Locked out" notice, got ${lockedNotices(platform).length}: ${JSON.stringify(platform.sent.map((s) => s.text))}`);
    // No round-cap leak, and a lockout is a clean governance exit, not a loop_error.
    assert.ok(!platform.sent.some((s) => /too many tool steps|halt:/i.test(s.text)), 'no halt leak to chat');
    assert.ok(!readAuditLogs(200).some((e) => e.action === 'loop_error'), 'a locked ceremony must not write a loop_error');
    assert.deepStrictEqual(ran, [], 'nothing executes when the owner is locked out');
  });
});
