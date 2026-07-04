'use strict';
/**
 * M5 context-engineering — the budget-fit seam.
 *
 * Proves the EXACT wiring runAgentLoop builds: a real bare-agent `Loop` whose `assemble` hook is
 * `unitAssembler((units) => context.assembleUnits(units, { budget }))` (litectx's `assemble` verb,
 * surfaced through the context wrapper). Runs against the INSTALLED litectx + bare-agent, not mocks.
 *
 * The load-bearing claim: as a conversation grows past the token budget, the view sent to the model
 * stays within budget, ALWAYS keeps the user's task (auto-pinned first user turn) + the newest turns,
 * and drops OLDEST history first — never a hard cap, never a split tool bundle. The neg control (a huge
 * budget → nothing dropped) is what makes the "fewer messages" assertion able to fail.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { setMultisDir } = require('../../src/config');
const { Loop, unitAssembler } = require('bare-agent');

let context;
let tmp;

// A provider that records the messages it is handed each round (this IS the assembled view — the Loop
// applies `assemble` before calling generate), then returns a text-only answer so the loop runs once.
function recordingProvider() {
  const calls = [];
  return {
    calls,
    generate: async (messages) => {
      // Preserve tool_calls/tool_call_id — the atomic-bundle assertion reads them.
      calls.push({ messages: messages.map((m) => ({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id })) });
      return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

// Build the SAME hook runAgentLoop wires (src/bot/handlers.js) for a given budget.
const hookFor = (budget) =>
  budget ? unitAssembler((units) => context.assembleUnits(units, { budget })) : null;

// A long transcript: task (first user, auto-pinned) + many large filler turns, oldest → newest.
const FILLER = 'x'.repeat(2000); // ~500 tokens each (approxTokens = chars/4)
function longTranscript(n) {
  const msgs = [{ role: 'user', content: 'TASK: summarize the project status.' }];
  for (let i = 1; i <= n; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${FILLER}` });
  }
  return msgs;
}

describe('M5 context-engineering — assemble budget-fit seam', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-m5-'));
    setMultisDir(tmp);
    context = require('../../src/context');
    await context.init({ documents: {} });
  });

  after(() => {
    setMultisDir(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('assembleUnits throws before init is impossible here (init ran) — returns a fitted envelope', async () => {
    const units = [{ id: 'a', role: 'user', content: 'hello', tokensApprox: 2 }];
    const r = await context.assembleUnits(units, { budget: 100000 });
    assert.ok(Array.isArray(r.units) && Array.isArray(r.dropped) && typeof r.tokens === 'number',
      'assemble returns the {units, dropped, tokens} envelope');
    assert.strictEqual(r.units.length, 1, 'a tiny transcript under budget keeps everything');
  });

  it('under a tight budget: drops OLDEST history, keeps the task (pinned) + the newest turn', async () => {
    const msgs = longTranscript(12); // 1 task + 12 fillers ≈ 6000+ tokens
    const provider = recordingProvider();
    const loop = new Loop({ provider, assemble: hookFor(1500) });

    await loop.run(msgs, [], {});

    const sent = provider.calls[0].messages;
    assert.ok(sent.length < msgs.length, `budget fitted the view (sent ${sent.length} of ${msgs.length})`);
    // Task = first user turn, auto-pinned by toUnits → never dropped.
    assert.ok(sent.some((m) => m.content.startsWith('TASK:')), 'the pinned task survives the cut');
    // Recency-anchored → the newest turn survives.
    assert.ok(sent.some((m) => m.content.startsWith('turn 12 ')), 'the newest turn survives');
    // An OLD middle turn is what got dropped.
    assert.ok(!sent.some((m) => m.content.startsWith('turn 2 ')), 'an old turn was dropped');
  });

  it('NEG CONTROL: a huge budget drops nothing — the full transcript reaches the model', async () => {
    const msgs = longTranscript(12);
    const provider = recordingProvider();
    const loop = new Loop({ provider, assemble: hookFor(1_000_000) });

    await loop.run(msgs, [], {});

    // Same content, only the budget changed — so this proves the tight-budget drops were budget-driven.
    assert.strictEqual(provider.calls[0].messages.length, msgs.length, 'nothing dropped under a huge budget');
  });

  it('NEG CONTROL: no hook (budget 0/null) sends full context — the pre-M5 path is unchanged', async () => {
    const msgs = longTranscript(12);
    const provider = recordingProvider();
    const loop = new Loop({ provider, assemble: hookFor(0) }); // hookFor(0) === null

    await loop.run(msgs, [], {});

    assert.strictEqual(provider.calls[0].messages.length, msgs.length, 'no assemble hook → all messages sent');
  });

  it('never splits an atomic tool-call/result bundle across the budget boundary', async () => {
    // A tool-call bundle: assistant(tool_calls) + its tool result — toUnits groups them atomic.
    const msgs = [
      { role: 'user', content: 'TASK: run the thing.' },
      ...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${FILLER}` })),
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: `RESULT ${FILLER}` },
    ];
    const provider = recordingProvider();
    const loop = new Loop({ provider, assemble: hookFor(2000) });

    await loop.run(msgs, [], {});

    const sent = provider.calls[0].messages;
    const hasCall = sent.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length);
    const hasResult = sent.some((m) => m.role === 'tool' && m.content?.startsWith('RESULT'));
    assert.strictEqual(hasCall, hasResult, 'the tool-call and its result are kept-or-dropped together (atomic)');
  });
});
