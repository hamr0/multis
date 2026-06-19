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

/**
 * Build a PIN challenge for the gate policy (#5). When a PIN-class tool (exec,
 * read_file) is invoked on the agent/natural-language path and the owner's PIN
 * session is stale, the gate calls this: it prompts in the owner's chat, waits
 * for the reply via the SAME PendingRegistry path the approval flow uses
 * (so the router's gate_reply dispatch delivers it), verifies, and resolves true/false
 * so the same tool call resumes or is cancelled. No second LLM round.
 *
 * Returns a function (ctx) => Promise<boolean>. true = allow (PIN fresh, not
 * configured, or just verified); false = deny (timeout, wrong PIN, lockout, or
 * no channel to prompt on — fails closed).
 */
function createPinChallenge({ platformRegistry, pinManager, pending, timeoutMs = 300_000 } = {}) {
  // opts.echo (M9): the verbatim RESOLVED action the PIN authorises (e.g. the exact
  // `rm -rf …` command), so the owner approves what will actually run — not a model
  // intent (POC finding #2). The LLM-path caller (gate.js) passes only ctx; echo is
  // optional and omitted there, so the prompt degrades to the generic line.
  return async function pinChallenge(ctx, opts = {}) {
    if (!pinManager || !pinManager.isEnabled()) return true; // no PIN configured
    const auth = pinManager.needsAuth(ctx?.senderId);
    if (auth === false) return true; // session still fresh

    const platform = platformRegistry?.get(ctx?.platform);
    if (!platform || typeof platform.send !== 'function') return false; // can't prompt → deny

    if (auth === 'locked') {
      try { await platform.send(ctx.chatId, 'Locked out due to failed PIN attempts. Try again later.'); } catch { /* ignore */ }
      return false;
    }

    const echoLine = opts.echo ? `\n\n  ${opts.echo}\n` : ' ';
    try {
      await platform.send(ctx.chatId, `🔒 That action needs your PIN.${echoLine}Reply with your PIN:`);
    } catch {
      return false;
    }

    const reply = await waitForReply(pending, ctx.chatId, ctx.senderId, { timeoutMs });
    if (reply == null) {
      try { await platform.send(ctx.chatId, 'PIN timed out — action cancelled.'); } catch { /* ignore */ }
      return false;
    }
    const result = pinManager.authenticate(ctx.senderId, reply.trim());
    if (!result.success) {
      try { await platform.send(ctx.chatId, result.reason); } catch { /* ignore */ }
      return false;
    }
    try { await platform.send(ctx.chatId, 'PIN accepted.'); } catch { /* ignore */ }
    return true;
  };
}

/**
 * Build a typed-confirmation challenge for catastrophic commands (the third
 * tier above PIN). After the PIN clears, the gate calls this for the small set
 * of machine-wreckers (rm -rf /, dd to a device, mkfs, fork bomb, shutdown…):
 * it shows the exact command and requires the owner to reply the literal word
 * CONFIRM — a deliberate speed bump a stray message can't satisfy. Routes and
 * waits via the same PendingRegistry path as the PIN/approval flow.
 *
 * Returns (ctx, command) => Promise<boolean>. true only on an exact "CONFIRM".
 */
function createConfirmChallenge({ platformRegistry, pending, timeoutMs = 300_000 } = {}) {
  return async function confirmChallenge(ctx, command) {
    const platform = platformRegistry?.get(ctx?.platform);
    if (!platform || typeof platform.send !== 'function') return false; // can't prompt → deny
    try {
      await platform.send(ctx.chatId,
        `⚠️ This command can destroy data or your system:\n\n  ${command}\n\n`
        + `Reply CONFIRM (exactly, all caps) within 5 minutes to run it. Anything else cancels.`);
    } catch {
      return false;
    }
    const reply = await waitForReply(pending, ctx.chatId, ctx.senderId, { timeoutMs });
    if (reply == null) {
      try { await platform.send(ctx.chatId, 'Confirmation timed out — action cancelled.'); } catch { /* ignore */ }
      return false;
    }
    if (reply.trim() === 'CONFIRM') return true;
    try { await platform.send(ctx.chatId, 'Not confirmed — action cancelled.'); } catch { /* ignore */ }
    return false;
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

module.exports = {
  createHumanPrompt,
  createPinChallenge,
  createConfirmChallenge,
};
