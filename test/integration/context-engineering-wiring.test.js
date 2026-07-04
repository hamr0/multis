'use strict';
/**
 * M5 context-engineering — PRODUCTION WIRING test (complements context-engineering.test.js, which proves
 * the library seam in isolation). This one drives the REAL path: `/ask` → createMessageRouter → routeAsk
 * → runAgentLoop → Loop. It exists to catch the exact gap a seam-only test misses — that runAgentLoop
 * actually builds and passes the `assemble` hook. Mutation check: breaking the handler line
 * `const contextBudget = config?.memory?.context_budget` (force null) MUST turn the first assertion red.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { setMultisDir } = require('../../src/config');
const { createMessageRouter } = require('../../src/bot/handlers');
const { mockPlatform } = require('../helpers/setup');
const { Message } = require('../../src/platforms/message');

let context, tmp;
const FILLER = 'x'.repeat(2000); // ~500 tokens/turn

// A provider that records the messages array it is handed (this IS the assembled view the Loop sends).
function recordingProvider() {
  const calls = [];
  return {
    calls,
    generate: async (messages) => {
      calls.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

// Stub indexer whose recentMemory returns a long conversation history (newest-first, as litectx does).
function longHistoryIndexer(nTurns) {
  const eps = [];
  for (let i = 0; i < nTurns; i++) {
    eps.push({ content: `turn ${i}`, meta: { turns: [{ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${FILLER}` }] } });
  }
  return {
    recentMemory: async () => [...eps].reverse(), // newest-first
    recallMemory: async () => [],
    search: async () => [],
    rememberEpisode: async () => ({}),
    rememberFact: async () => ({}),
    promotionSweep: async () => 0,
    forgetMemory: async () => 0,
    recentActivity: async () => [],
    countMemory: async () => 0,
    getStats: () => ({ indexedFiles: 0, totalChunks: 0, byType: {} }),
    store: { recordSearchAccess: () => {} },
  };
}

const ownerMsg = (text) => new Message({
  platform: 'telegram', chatId: 'chat1', senderId: 'owner1', text, chatName: 'Owner', isSelf: false,
});

function envWith(contextBudget) {
  const config = {
    pairing_code: 'T', allowed_users: ['owner1'], owner_id: 'owner1',
    llm: { provider: 'mock', apiKey: 'x', max_tool_rounds: 3 },
    governance: { enabled: false }, security: {},
    // recent_window 30 so all 20 history turns reach the transcript; budget is the only variable.
    memory: { recent_window: 30, context_budget: contextBudget },
  };
  fs.writeFileSync(path.join(tmp, '.multis', 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(tmp, '.multis', 'auth', 'governance.json'),
    JSON.stringify({ commands: { allowlist: ['.*'], denylist: [] }, paths: { allowed: ['.*'], denied: [] } }));
  return config;
}

async function runAsk(contextBudget) {
  const config = envWith(contextBudget);
  const platform = mockPlatform();
  const provider = recordingProvider();
  const router = createMessageRouter(config, {
    provider, indexer: longHistoryIndexer(20),
    tools: [], toolsConfig: {}, runtimePlatform: 'linux',
  });
  await router(ownerMsg('/ask what is the status'), platform);
  return provider;
}

describe('M5 context-engineering — production wiring (routeAsk → runAgentLoop → Loop)', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-m5w-'));
    for (const sub of ['data', 'auth', 'logs', 'run']) fs.mkdirSync(path.join(tmp, '.multis', sub), { recursive: true });
    setMultisDir(path.join(tmp, '.multis'));
    context = require('../../src/context');
    await context.init({ documents: {} }); // real assembleUnits (else fail-open would mask a broken wire)
  });

  after(() => {
    setMultisDir(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('with a budget set, runAgentLoop budget-fits the transcript the model receives', async () => {
    // Full transcript first (budget off) — the count is derived, not hardcoded (it includes the system
    // message + 20 history turns + the live question). Same inputs, only the budget differs across runs.
    const full = (await runAsk(null)).calls[0];
    const fit = (await runAsk(1500)).calls[0];

    assert.ok(fit.length < full.length, `budget-fit shrank the transcript (${fit.length} < ${full.length})`);
    // Never-dropped anchors: the live question (newest) + the auto-pinned first turn survive.
    assert.ok(fit.some((m) => m.content.includes('what is the status')), 'the live question survives');
    assert.ok(fit.some((m) => m.content.startsWith('turn 19')), 'the newest history turn survives');
    assert.ok(fit.some((m) => m.content.startsWith('turn 0 ')), 'the pinned first history turn survives');
    // A MIDDLE turn is what gets shed (in multis the oldest turn is the pinned anchor, so the budget
    // drops from the middle, not the very oldest — a real property of routeAsk's transcript order).
    assert.ok(!fit.some((m) => m.content.startsWith('turn 9 ')), 'a middle turn was dropped to fit budget');
  });

  it('NEG CONTROL: budget off (null) sends the FULL transcript — proves the drop was budget-driven, not incidental', async () => {
    const full = (await runAsk(null)).calls[0];
    // system + 20 turns + question, all present. If the tight-budget run above sent this same set, the
    // feature would be doing nothing — this control is what makes the "shrank" assertion able to fail.
    assert.ok(full.some((m) => m.content.startsWith('turn 9 ')), 'the middle turn IS present when budget is off');
    assert.ok(full.length >= 22, `full transcript reaches the model unfitted (${full.length} msgs)`);
  });
});
