'use strict';

/**
 * REGRESSION (found live 2026-06-23, L3 of the post-migration manual pass):
 * a WRONG PIN destroys the parked ceremony, so the promised retry is impossible.
 *
 * The router's `ceremony_action` dispatch (handlers.js) clears the parked entry on
 * ANY 4–6 digit reply, then resumes. On a wrong PIN the core returns
 * RESULT.DENIED with "Wrong PIN. N attempts remaining." — but nothing RE-PARKS
 * the ceremony. So the very next reply (the CORRECT PIN) finds no parked entry and
 * falls through to the normal /ask path: the deferred destructive action never runs,
 * and on the LLM door it re-triggers the loop into the round cap (halt:gate.terminated).
 *
 * pin.js grants 3 attempts before lockout, and the UX literally says "N attempts
 * remaining" — but the park only ever survived ONE reply. The old wrong-PIN test only
 * tried a single wrong PIN and asserted "denied"; it never tried wrong-THEN-correct,
 * so this was latent on BOTH the slash and LLM doors.
 *
 * This drives the REAL createMessageRouter through the slash door (/exec rm <file>,
 * a destructive-not-catastrophic command) with the REAL governed core + REAL
 * PendingRegistry + REAL PinManager. wrong PIN → correct PIN MUST execute the action.
 * Pre-fix: the file survives (correct PIN fell through). Post-fix: the file is deleted.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMessageRouter } = require('../../src/bot/handlers');
const { buildToolRegistry } = require('../../src/tools/registry');
const { PinManager, hashPin } = require('../../src/security/pin');
const { createCeremonyPrompt, createVerifyPin } = require('../../src/governance/human-channel');
const { createTestEnv, mockPlatform, mockToolProvider, realGov, msg } = require('../helpers/setup');

// realGov returns only the createGate bundle; the real createGovernanceCarrier also
// folds in the PIN ceremony pieces (handlers.js:131-134). Mirror that here with the
// REAL PinManager / createVerifyPin / createCeremonyPrompt so the ceremony runs for real.
function carrierWithCeremony(built, pinManager) {
  const platformRegistry = new Map();
  return {
    platformRegistry,
    setPlatformRegistry(reg) { for (const [k, v] of reg) platformRegistry.set(k, v); },
    resolve: async () => ({
      ...built,
      ceremonyPrompt: createCeremonyPrompt({ platformRegistry, pinManager }),
      verifyPin: createVerifyPin({ pinManager }),
      pinConfigured: pinManager.isEnabled(),
    }),
  };
}

// `rm` is in the denylist → it passes the Axis-A floor (bash.allow ∪ denylist) to
// REACH the core's ceremony, where the classifier rules it destructive (not
// catastrophic — no -rf, non-root target) → PIN ceremony.
const GOVERNANCE = {
  commands: { allowlist: ['ls', 'cat', 'echo'], denylist: ['rm'] },
  paths: { allowed: ['/tmp', os.tmpdir()], denied: ['/etc/passwd'] },
};

function stubIndexer() {
  return {
    search: () => [],
    indexFile: async () => 0,
    indexBuffer: async () => 0,
    recallMemory: async () => [],
    rememberEpisode: async () => ({}),
    rememberFact: async () => ({}),
    promotionSweep: async () => 0,
    forgetMemory: async () => 0,
    recentMemory: async () => [],
    countMemory: async () => 0,
    getStats: () => ({ indexedFiles: 0, totalChunks: 0, byType: {} }),
    store: { recordSearchAccess: () => {} },
  };
}

describe('ceremony re-park — wrong PIN must not kill the retry', () => {
  let env;
  afterEach(() => env?.cleanup());

  it('a wrong PIN then the correct PIN EXECUTES the destructive action', async () => {
    env = createTestEnv({
      allowed_users: ['user1'],
      owner_id: 'user1',
      security: { checkpoint_tools: [], pin_hash: hashPin('1234') },
      llm: { provider: 'mock', apiKey: 'x' },
    });
    const platform = mockPlatform();
    const { built } = await realGov(env.config, GOVERNANCE);
    const carrier = carrierWithCeremony(built, new PinManager(env.config));
    const router = createMessageRouter(env.config, {
      provider: mockToolProvider([]),       // bare /ask fall-through returns harmless text
      indexer: stubIndexer(),
      tools: buildToolRegistry({}, 'linux'),
      toolsConfig: {},
      runtimePlatform: 'linux',
      gov: carrier,
    });
    router.registerPlatform('telegram', platform); // so ceremonyPrompt can route the PIN ask

    // A real file the destructive command will delete — its disappearance is the
    // unambiguous proof the action executed (no stubbing the shell).
    const target = path.join(os.tmpdir(), `multis-repark-${process.pid}.txt`);
    fs.writeFileSync(target, 'delete-me');

    // 1) Destructive request → ceremony prompted, action parked, file UNTOUCHED.
    await router(msg(`/exec rm ${target}`), platform);
    assert.ok(fs.existsSync(target), 'file must survive until a correct PIN');
    assert.match(platform.lastTo('chat1').text, /PIN/i, 'a PIN was requested');

    // 2) WRONG PIN → declined with attempts-remaining, file STILL there.
    await router(msg('1259'), platform);
    assert.ok(fs.existsSync(target), 'wrong PIN must not run the action');
    assert.match(platform.lastTo('chat1').text, /wrong pin|attempts remaining/i,
      'wrong PIN is rejected with a retry-able reason');

    // 3) CORRECT PIN → the ceremony must still be parked → resume → EXECUTE.
    //    Pre-fix the entry was gone (no re-park), so this PIN fell through to /ask
    //    and the file survived. This is the assertion that flips red→green.
    await router(msg('1234'), platform);
    assert.ok(!fs.existsSync(target),
      'after wrong-then-correct PIN the destructive action MUST execute (re-park regression)');

    try { fs.rmSync(target, { force: true }); } catch { /* already gone on green */ }
  });
});
