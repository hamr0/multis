'use strict';

/**
 * humanChannel for bareguard Gate. The single approval path for every gate
 * ask/halt — including always-ask confirms (flags) that previously went through
 * a separate bare-agent Checkpoint. Routes events back to the originating chat
 * via event.action._ctx, prompts the user, waits for a reply parked on the
 * shared PendingRegistry (delivered by the router's gate_reply dispatch), and
 * resolves to bareguard's {decision, reason, newCap} shape.
 *
 * Test code can pass an `autoResponder(event)` that returns the decision
 * directly without touching the platform — used by integration tests so they
 * don't need to mock pendingApprovals.
 */

/**
 * Resolve the owner's approval channel (#7). Prefers Telegram, where owner_id is
 * both the chat and the sender (DM), so the prompt and the reply-wait are
 * deterministic. Returns null when there's no such channel — callers fall back
 * to the requester (on a Beeper-only deploy the requester is the owner anyway).
 */
function resolveOwnerRoute(config, platformRegistry) {
  const ownerId = config?.owner_id;
  if (ownerId && platformRegistry?.get && platformRegistry.get('telegram')) {
    return { senderId: String(ownerId), chatId: String(ownerId), platformName: 'telegram' };
  }
  return null;
}

/**
 * Build a humanPrompt closure. Pass the platformRegistry so the prompt is
 * routed to the right transport. PIN verification is layered inside.
 */
function createHumanPrompt({ platformRegistry, pinManager, config, autoResponder, pending, timeoutMs = 60_000 } = {}) {
  return async function humanPrompt(event) {
    if (autoResponder) {
      return autoResponder(event);
    }

    const reqCtx = event.action?._ctx || {};
    // #7: route approvals to the OWNER, never the requester — otherwise any
    // future non-owner-reachable ask-gated tool would be self-approvable. Falls
    // back to the requester only when no deterministic owner channel exists
    // (e.g. a Beeper-only deploy, where the requester note-to-self IS the owner).
    const route = resolveOwnerRoute(config, platformRegistry) || {
      senderId: reqCtx.senderId, chatId: reqCtx.chatId, platformName: reqCtx.platform,
    };
    const { senderId, chatId, platformName } = route;
    if (!senderId || !chatId || !platformName || !platformRegistry) {
      return { decision: 'deny', reason: 'humanChannel: missing routing fields' };
    }
    const platform = platformRegistry.get(platformName);
    if (!platform || typeof platform.send !== 'function') {
      return { decision: 'deny', reason: `humanChannel: platform "${platformName}" not available` };
    }

    const summary = summarizeEvent(event);

    // A halt means the run already hit a hard limit (e.g. the tool-round cap).
    // multis has no top-up/continue UX, so there's no real yes/no choice — the
    // run ends either way. Inform the owner and terminate WITHOUT blocking on a
    // reply (waiting was both confusing — "deny" was meaningless — and the cause
    // of a needless 60s humanChannel timeout on every cap halt). (#3)
    if (event.kind === 'halt') {
      try { await platform.send(chatId, summary); } catch { /* best-effort */ }
      return { decision: 'terminate', reason: 'halt acknowledged (no top-up UX)' };
    }

    // Serial-poll transports (Beeper) cannot do inline HITL: awaiting the reply
    // here freezes the poll loop, and the reply can only arrive on the next poll
    // the frozen loop never runs — the latent twin of the ceremony deadlock
    // (proven 2026-06-23). Fail closed: notify and deny rather than deadlock. The
    // one interactive gate that works on Beeper is the destructive PIN ceremony
    // (park-and-resume); risky actions now escalate to it, so an inline yes/no is
    // no longer the approval path here. Telegram dispatches each update
    // concurrently, so the reply lands in its own context — it still inline-waits.
    if (reqCtx.platform === 'beeper') {
      try {
        await platform.send(chatId, `${summary}\n\n(Auto-declined — Beeper can't run an inline yes/no. Destructive actions ask for your PIN instead; re-run if you meant it.)`);
      } catch { /* best-effort */ }
      return { decision: 'deny', reason: 'serial-poll transport: ask auto-denied (no inline HITL)' };
    }

    try {
      await platform.send(chatId, summary);
    } catch (err) {
      return { decision: 'deny', reason: `humanChannel: send failed: ${err.message}` };
    }

    // Wait for the reply.
    const reply = await waitForReply(pending, chatId, senderId, { timeoutMs });
    if (reply == null) {
      return { decision: 'deny', reason: `humanChannel: timeout after ${timeoutMs}ms` };
    }

    const ans = reply.trim().toLowerCase();
    if (ans === 'yes' || ans === 'y' || ans === 'allow') {
      // For halts, treat 'yes' as 'terminate' unless caller wants topup —
      // multis has no top-up UX. Terminate is the safe default.
      if (event.kind === 'halt') {
        return { decision: 'terminate', reason: 'operator confirmed halt' };
      }
      return { decision: 'allow' };
    }
    if (ans === 'no' || ans === 'n' || ans === 'deny') {
      return { decision: 'deny' };
    }
    if (ans === 'stop' || ans === 'terminate' || ans === 'kill') {
      return { decision: 'terminate', reason: 'operator requested terminate' };
    }
    return { decision: 'deny', reason: `humanChannel: unrecognized reply "${ans}"` };
  };
}

function summarizeEvent(event) {
  if (event.kind === 'halt') {
    // Tool-round cap: the model kept calling tools without finishing. Plain
    // language, no misleading yes/no (the run has already stopped). (#3)
    if (event.rule === 'limits.maxToolRounds') {
      const cap = (event.reason && event.reason.match(/max\s+(\d+)/)?.[1]) || '';
      const limit = cap ? ` (limit ${cap} steps)` : '';
      return `⚠️ Stopped — I took too many tool steps${limit} without finishing that. Try rephrasing it or breaking it into smaller asks.`;
    }
    // Budget / other hard limits.
    const spent = event.context?.spent || {};
    const cap = event.context?.cap || {};
    const spendStr = spent.costUsd != null ? `$${spent.costUsd.toFixed(4)}` : '?';
    const capStr = cap.costUsd != null ? `$${cap.costUsd}` : '?';
    return `⚠️ Stopped — ${event.rule}: ${event.reason || ''} (spent ${spendStr} of ${capStr}).`;
  }
  // ask
  const action = event.action ? JSON.stringify({ type: event.action.type, ...summarizedArgs(event.action) }).slice(0, 300) : '(no action)';
  return [
    `Approval needed: ${event.rule}`,
    event.reason ? `Reason: ${event.reason}` : '',
    `Action: ${action}`,
    `Reply "yes" to allow, "no" to deny.`,
  ].filter(Boolean).join('\n');
}

function summarizedArgs(action) {
  // Trim large fields so the prompt isn't huge.
  const out = {};
  for (const k of Object.keys(action)) {
    if (k === 'type' || k === '_ctx') continue;
    const v = action[k];
    if (typeof v === 'string' && v.length > 100) out[k] = v.slice(0, 100) + '…';
    else out[k] = v;
  }
  return out;
}

/**
 * Park a gate challenge (approval / PIN / CONFIRM) on the shared PendingRegistry
 * and await the owner's reply. The challenge registers a 'gate_reply' entry whose
 * payload is a `resolve` fn; the router's single pending dispatch calls it when a
 * message arrives for this conversation. One entry per (chat, sender) → a reply
 * can never satisfy the wrong challenge (the old shared-Map footgun).
 *
 * The setTimeout is authoritative for cancellation; the registry TTL is a loose
 * backstop set well past it, so the router never announces a "prompt expired" for
 * a gate reply (the challenge prints its own "timed out" copy).
 *
 * @returns {Promise<string|null>} the raw reply text, or null on timeout.
 */
function waitForReply(pending, chatId, senderId, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    const done = (text) => {
      clearTimeout(timer);
      pending.clear(chatId, senderId);
      resolve(text);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    // No `match` → any next message from this conversation is the reply (the
    // challenge interprets yes/no/PIN/CONFIRM itself), preserving prior behavior.
    pending.set(chatId, senderId, 'gate_reply', { resolve: done, ttlMs: timeoutMs + 60_000 });
  });
}

/**
 * Park-and-resume ceremony (M9 fix 2026-06-22) — split of createPinChallenge into
 * two non-blocking halves so a serial poll loop (Beeper) never deadlocks:
 *
 *   createCeremonyPrompt — sends the PIN prompt (or the lockout line) and returns a
 *     status; the CALLER then parks the action and RETURNS (freeing the loop).
 *   createVerifyPin      — on the PIN reply, the core verifies it here, then runs.
 *
 * Neither awaits the reply, so neither holds the poll loop. Replaces the old inline
 * `await pinChallenge → waitForReply`.
 */
function createCeremonyPrompt({ platformRegistry, pinManager } = {}) {
  return async function ceremonyPrompt(ctx, opts = {}) {
    const platform = platformRegistry?.get(ctx?.platform);
    if (!platform || typeof platform.send !== 'function') return 'no-channel';
    if (pinManager && pinManager.needsAuth(ctx?.senderId) === 'locked') {
      try { await platform.send(ctx.chatId, 'Locked out due to failed PIN attempts. Try again later.'); } catch { /* ignore */ }
      return 'locked';
    }
    // Same wording the inline challenge used; opts.echo is the verbatim RESOLVED
    // action so the owner approves what will actually run (POC finding #2).
    const echoLine = opts.echo ? `\n\n  ${opts.echo}\n` : ' ';
    try {
      await platform.send(ctx.chatId, `🔒 That action needs your PIN.${echoLine}Reply with your PIN:`);
    } catch {
      return 'no-channel';
    }
    return 'prompted';
  };
}

/** Verify a parked ceremony's PIN reply. Returns { ok, reason? }. No PIN configured
 *  → { ok: true } (parity with the legacy `!isEnabled() → allow`). */
function createVerifyPin({ pinManager } = {}) {
  return async function verifyPin(ctx, reply) {
    if (!pinManager || !pinManager.isEnabled()) return { ok: true };
    const r = pinManager.authenticate(ctx?.senderId, String(reply ?? '').trim());
    // Propagate `locked` so the caller can tell a retryable wrong PIN (attempts
    // remain → re-park the ceremony) from a terminal lockout (stay cleared).
    return r.success ? { ok: true } : { ok: false, reason: r.reason, locked: r.locked };
  };
}

module.exports = {
  createHumanPrompt,
  createCeremonyPrompt,
  createVerifyPin,
};
