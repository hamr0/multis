/**
 * bare-agent ≥0.27 honest-termination tokens must reach chat as an honest
 * stopped-early reply, never as a raw thrown token.
 *
 * The seam (bare-agent 0.19 → 0.29 bump, 2026-07-15): the Loop gained non-halt
 * terminal error values — 'truncated:max_tokens' / 'refusal' / 'context_exceeded'
 * (BA-6/BA-13), 'denied:<tool>' (BA-11), 'stuck:<tool>' (BA-12). Pre-0.27 a
 * truncated or refused round came back as a CLEAN EMPTY answer and a deny-spin
 * ground to the round cap; post-bump they land in runAgentLoop's `result.error`,
 * where the old code fell through to `throw new Error(String(result.error))` and
 * the caller leaked "LLM error: truncated:max_tokens" to chat.
 *
 * The fix maps the bounded exits to the model's preserved text (BA-5) plus a
 * "(stopped early — …)" note, keeps tool names OUT of the reply (contacts can
 * reach this path), and writes a `loop_bounded` audit line carrying the token.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createMessageRouter } = require('../../src/bot/handlers');
const { createTestEnv, mockPlatform, msg } = require('../helpers/setup');
const { PendingRegistry } = require('../../src/bot/pending');
const { readAuditLogs } = require('../../src/governance/audit');

// exec allowlist is 'echo' only — 'curl …' passes arg-validation but the Axis-A
// floor DENIES it (not in allowlist), advisory-style, so a model that repeats the
// identical call trips bare-agent's BA-11 deny-streak (default 3) → 'denied:exec'.
const GOV = { commands: { allowlist: ['echo'], denylist: [] }, paths: { allowed: ['.*'], denied: [] } };

function execStub(ran) {
  return {
    name: 'exec', description: 'Run a shell command', platforms: ['linux'], owner_only: true,
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async (args) => { ran.push(args.command); return `ran: ${args.command}`; },
  };
}

function buildLLM(provider, ran = []) {
  const env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1' });
  const platform = mockPlatform();
  const router = createMessageRouter(env.config, {
    provider, indexer: { search: () => [], indexFile: async () => 0, indexBuffer: async () => 0,
      recallMemory: async () => [], rememberEpisode: async () => ({}), rememberFact: async () => ({}), promotionSweep: async () => 0, forgetMemory: async () => 0, recentMemory: async () => [], countMemory: async () => 0,
      getStats: () => ({ indexedFiles: 0, totalChunks: 0, byType: {} }), store: { recordSearchAccess: () => {} } },
    tools: [execStub(ran)], toolsConfig: {}, runtimePlatform: 'linux',
    pending: new PendingRegistry(), fileless: true, governanceFile: GOV,
  });
  router.registerPlatform('telegram', platform);
  return { env, platform, router };
}

describe('bounded loop terminations reach chat honestly (bare-agent ≥0.27 tokens)', () => {
  it("a truncated round returns the model's partial text + a stopped-early note (never the raw token)", async () => {
    const provider = {
      generate: async () => ({
        text: 'Here is the first half of the answer', toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'max_tokens',
      }),
    };
    const { platform, router } = buildLLM(provider);
    await router(msg('/ask summarize everything'), platform);

    const texts = platform.sent.map((s) => s.text);
    assert.ok(texts.some((t) => t.includes('Here is the first half') && t.includes('stopped early')),
      `partial text + stopped-early note expected, got: ${JSON.stringify(texts)}`);
    assert.ok(!texts.some((t) => /LLM error|truncated:max_tokens/.test(t)),
      `raw token leaked to chat: ${JSON.stringify(texts)}`);
    const bounded = readAuditLogs(50).filter((e) => e.action === 'loop_bounded');
    assert.strictEqual(bounded.length, 1, 'exactly one loop_bounded audit line');
    assert.strictEqual(bounded[0].error, 'truncated:max_tokens');
  });

  it('a refusal with no text gets the honest note alone (was a clean empty answer pre-0.27)', async () => {
    const provider = {
      generate: async () => ({ text: '', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'refusal' }),
    };
    const { platform, router } = buildLLM(provider);
    await router(msg('/ask recite the lyrics'), platform);

    const texts = platform.sent.map((s) => s.text);
    assert.ok(texts.some((t) => t.includes('stopped early') && t.includes('declined')),
      `refusal note expected, got: ${JSON.stringify(texts)}`);
    assert.ok(!texts.some((t) => /LLM error|refusal/.test(t)), `raw token leaked: ${JSON.stringify(texts)}`);
  });

  it('a governance deny-spin short-circuits (BA-11) with the policy note — tool name stays out of chat', async () => {
    // The worst-case model: repeats the identical floor-denied command every round.
    const ran = [];
    let rounds = 0;
    const provider = {
      generate: async () => {
        rounds++;
        return {
          text: '', usage: { inputTokens: 1, outputTokens: 1 },
          toolCalls: [{ id: `t${rounds}`, name: 'exec', arguments: { command: 'curl example.com' } }],
        };
      },
    };
    const { platform, router } = buildLLM(provider, ran);
    await router(msg('/ask fetch that page'), platform);

    const texts = platform.sent.map((s) => s.text);
    assert.ok(texts.some((t) => t.includes('stopped early') && t.includes('blocked by policy')),
      `policy note expected, got: ${JSON.stringify(texts)}`);
    // The raw 'denied:exec' token (and with it the tool name) must not reach chat.
    assert.ok(!texts.some((t) => /LLM error|denied:/.test(t)), `raw token leaked: ${JSON.stringify(texts)}`);
    assert.deepStrictEqual(ran, [], 'the denied command never executes');
    // BA-11 default (3) fired well before the round cap (5) — the spin was cut short.
    assert.ok(rounds <= 4, `deny-spin should short-circuit at 3 denials, provider ran ${rounds} rounds`);
    const bounded = readAuditLogs(50).filter((e) => e.action === 'loop_bounded');
    assert.strictEqual(bounded.length, 1, 'exactly one loop_bounded audit line');
    assert.match(bounded[0].error, /^denied:/);
  });
});
