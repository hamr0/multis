'use strict';

/**
 * KEYSTONE REGRESSION (M10 — owner-ask gate redesign, §6).
 *
 * The "stuck on delete" bug (live 2026-06-24): a parked destructive request is
 * written to conversation memory with NO recorded ending, so the model replays the
 * dangling destructive request on every subsequent turn.
 *
 * Root cause (handlers.js): routeAsk recorded the user message BEFORE the agent
 * loop; the loop parks the PIN ceremony and halts; routeAsk returns early and
 * the outcome is NEVER recorded. The ceremony_action resume records request→outcome
 * only at completion — a bare user request with no outcome is a dangling turn the
 * model re-issues.
 *
 * Definition of done (§6): a destructive request → park → {resolve | cancel} →
 * the conversation reads request→outcome, never a dangling request.
 *
 * SINCE M4 the conversation thread is the litectx episode ladder (no recent.json):
 * each exchange is written as ONE episode at completion (meta.turns = the paired
 * request→outcome turns), and the agent's window is reconstructed from episode
 * recency (recentMemory). So the two §5 invariants now read against the episode store:
 *   1. While an ask is PENDING, NO episode is written about this turn (pure control
 *      state, invisible to the model — recentMemory returns nothing).
 *   2. At completion the turn enters as ONE episode with paired (request → outcome)
 *      turns. A bare request with no outcome would dangle and replay.
 *
 * This drives the REAL createMessageRouter LLM door with the REAL governed core +
 * REAL PinManager + REAL PendingRegistry. A STATEFUL episode mock reads back through
 * recentMemory exactly as litectx would, so the window→provider replay path is real.
 * The PIN keystrokes must NEVER appear in any episode.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');

const { createMessageRouter } = require('../../src/bot/handlers');
const { createTestEnv, mockPlatform, msg } = require('../helpers/setup');
const { PinManager, hashPin } = require('../../src/security/pin');
const { PendingRegistry } = require('../../src/bot/pending');

const PIN = '1234';
// echo ∈ allowlist ∪ denylist → passes the Axis-A floor, classified DESTRUCTIVE
// (denylist membership) → PIN ceremony. Running it is harmless.
const GOV = { commands: { allowlist: ['echo'], denylist: ['echo'] }, paths: { allowed: ['.*'], denied: [] } };
const COMMAND = 'echo repro-marker';
const REQUEST = 'delete the scratch file';

const flush = () => new Promise((r) => setImmediate(r));
async function waitFor(pred, label, tries = 500) {
  for (let i = 0; i < tries; i++) { if (pred()) return; await flush(); }
  throw new Error(`waitFor timed out: ${label}`);
}

function execStub(ran, { silent = false } = {}) {
  return {
    name: 'exec', description: 'Run a shell command', platforms: ['linux'], owner_only: true,
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    // silent: model a command with no stdout (e.g. `rm`) → exercises the "✓ Done."
    // confirmation path (a successful silent action must still be confirmed).
    execute: async (args) => { ran.push(args.command); return silent ? '' : `ran: ${args.command}`; },
  };
}

// Content-aware provider: calls `exec` when the latest user turn is the destructive
// REQUEST; otherwise answers in plain text. So turn 1 (the request) parks a ceremony,
// and a later plain turn ("what time is it") is answered without re-issuing exec —
// UNLESS a dangling request is replayed back into the prompt, which is the bug.
function destructiveThenPlainProvider() {
  const calls = [];
  return {
    calls,
    generate: async (messages, tools, options) => {
      calls.push({ messages, options });
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const wantsDestructive = lastUser && /delete the scratch/i.test(lastUser.content || '');
      if (wantsDestructive) {
        return {
          text: '', usage: { inputTokens: 0, outputTokens: 0 },
          toolCalls: [{ id: `t${calls.length}`, name: 'exec', arguments: { command: COMMAND } }],
        };
      }
      return { text: 'It is noon.', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

function buildRouter(ran, execOpts = {}) {
  const env = createTestEnv({
    allowed_users: ['user1'], owner_id: 'user1',
    security: { pin_hash: hashPin(PIN), pin_timeout_hours: 24, checkpoint_tools: [] },
  });
  const platform = mockPlatform();
  const pinManager = new PinManager(env.config); pinManager.sessions = {};
  const provider = destructiveThenPlainProvider();
  const pending = new PendingRegistry();
  // Stateful episode store — the conversation thread since M4. rememberEpisode appends; recentMemory
  // reads back newest-first (with meta.turns), exactly as litectx 0.23.0 does. So the window the agent
  // loop replays is the REAL reconstructed-from-episodes window, and a dangling/eager write WOULD surface.
  const episodes = [];
  const router = createMessageRouter(env.config, {
    provider,
    indexer: { search: () => [], indexFile: async () => 0, indexBuffer: async () => 0,
      recallMemory: async () => [], rememberFact: async () => ({}), promotionSweep: async () => 0, forgetMemory: async () => 0,
      rememberEpisode: async (scope, body, opts = {}) => { episodes.push({ scope, body, meta: opts.meta || null }); return {}; },
      recentMemory: async (scope, { kind } = {}) => [...episodes].reverse().map((e) => ({ kind: 'episode', content: e.body, body: e.body, meta: e.meta })),
      countMemory: async () => episodes.length,
      getStats: () => ({ indexedFiles: 0, totalChunks: 0, byType: {} }), store: { recordSearchAccess: () => {} } },
    tools: [execStub(ran, execOpts)], toolsConfig: {}, runtimePlatform: 'linux',
    pinManager, pending, fileless: true, governanceFile: GOV,
    memoryBaseDir: env.memoryBaseDir,
  });
  router.registerPlatform('telegram', platform);
  // The conversation, oldest-first, as role-tagged turns reconstructed from the episodes (what the
  // model would see). Empty while a turn is parked; a paired exchange once it completes.
  const readRecent = () => episodes.flatMap((e) => (e.meta?.turns) || [{ role: 'user', content: e.body }]);
  return { env, platform, router, provider, readRecent };
}

const pinPrompts = (p) => p.sent.filter((s) => /needs your PIN|Reply with your PIN|enter your PIN/i.test(s.text));
const danglingRequest = (recent) => {
  // A user turn mentioning the destructive request with no following outcome line.
  for (let i = 0; i < recent.length; i++) {
    if (recent[i].role === 'user' && /delete the scratch/i.test(recent[i].content || '')) {
      const next = recent[i + 1];
      if (!next || next.role === 'user') return true; // nothing recorded after it
    }
  }
  return false;
};
const hasPinDigits = (recent) => recent.some((m) => new RegExp(`\\b${PIN}\\b`).test(m.content || ''));

describe('KEYSTONE — a parked destructive request must never dangle or replay', () => {
  let built;
  afterEach(() => built?.env?.cleanup());

  it('resolve path: request→outcome recorded, no dangling turn, PIN never stored', async () => {
    const ran = [];
    built = buildRouter(ran);
    const { platform, router, provider, readRecent } = built;

    // 1) Destructive request → ceremony prompted, action parked, nothing ran.
    const p = router(msg(`/ask ${REQUEST}`), platform);
    await waitFor(() => pinPrompts(platform).length > 0, 'PIN prompt');
    await p;
    assert.deepStrictEqual(ran, [], 'command must not run before the PIN');

    // §5 rule 1 — while PENDING, recent.json holds NOTHING about this turn.
    // (Today: the request was eagerly appended → a dangling user line. RED.)
    assert.deepStrictEqual(readRecent(), [],
      'while the ceremony is pending, recent.json must hold nothing about this turn');

    // 2) Correct PIN → resume → execute.
    await router(msg(PIN), platform);
    assert.deepStrictEqual(ran, [COMMAND], 'the correct PIN runs the parked command exactly once');

    // §5 rule 2 — the completed turn is recorded as a paired (request → outcome).
    // (Today: no outcome is ever recorded → the request dangles forever. RED.)
    const recent = readRecent();
    assert.ok(!danglingRequest(recent),
      `the destructive request must be paired with a recorded outcome, not left dangling: ${JSON.stringify(recent)}`);
    assert.ok(!hasPinDigits(recent), 'the PIN digits must never be written to recent.json');

    // 3) Next turn is a plain question → must be answered, NOT a replay of the
    //    destructive action (it would replay only if the request still dangled).
    const before = ran.length;
    await router(msg('/ask what time is it'), platform);
    assert.strictEqual(ran.length, before, 'a later plain question must not replay the destructive action');
    assert.match(platform.lastTo('chat1').text, /noon/i, 'the plain question is answered normally');
  });

  it('a silent destructive success is confirmed in chat (✓ Done), not just "PIN accepted"', async () => {
    // Live finding (2026-06-24): a successful `rm` (no stdout) showed only "PIN
    // accepted." with no confirmation it ran, while a FAILURE shows its error.
    const ran = [];
    built = buildRouter(ran, { silent: true });
    const { platform, router } = built;
    const p = router(msg(`/ask ${REQUEST}`), platform);
    await waitFor(() => pinPrompts(platform).length > 0, 'PIN prompt');
    await p;
    await router(msg(PIN), platform);
    assert.deepStrictEqual(ran, [COMMAND], 'the command ran');
    assert.ok(platform.sent.some((s) => /✓ Done\.|Done\./.test(s.text)),
      `a silent success must be confirmed, got: ${JSON.stringify(platform.sent.map((s) => s.text))}`);
  });

  it('cancel path: request→"cancelled" recorded, no dangling turn', async () => {
    const ran = [];
    built = buildRouter(ran);
    const { platform, router, readRecent } = built;

    const p = router(msg(`/ask ${REQUEST}`), platform);
    await waitFor(() => pinPrompts(platform).length > 0, 'PIN prompt');
    await p;

    // Cancel instead of supplying the PIN.
    await router(msg('cancel'), platform);
    assert.deepStrictEqual(ran, [], 'cancel must not run the action');

    const recent = readRecent();
    assert.ok(!danglingRequest(recent),
      `a cancelled request must be recorded as cancelled, not left dangling: ${JSON.stringify(recent)}`);
  });
});
