'use strict';

/**
 * humanChannel for bareguard Gate. Routes ask/halt events back to the
 * originating chat via event.action._ctx, prompts the user, waits for a reply
 * via the pendingApprovals Map (same pattern as src/bot/checkpoint.js), and
 * resolves to bareguard's {decision, reason, newCap} shape.
 *
 * Test code can pass an `autoResponder(event)` that returns the decision
 * directly without touching the platform — used by integration tests so they
 * don't need to mock pendingApprovals.
 */

const pendingHumanResponses = new Map(); // senderId → { resolve }

/**
 * Build a humanPrompt closure. Pass the platformRegistry so the prompt is
 * routed to the right transport. PIN verification is layered inside.
 */
function createHumanPrompt({ platformRegistry, pinManager, autoResponder, timeoutMs = 60_000 } = {}) {
  return async function humanPrompt(event) {
    if (autoResponder) {
      return autoResponder(event);
    }

    const ctx = event.action?._ctx || {};
    const { senderId, chatId, platform: platformName } = ctx;
    if (!senderId || !chatId || !platformName || !platformRegistry) {
      return { decision: 'deny', reason: 'humanChannel: missing _ctx routing fields' };
    }
    const platform = platformRegistry.get(platformName);
    if (!platform || typeof platform.send !== 'function') {
      return { decision: 'deny', reason: `humanChannel: platform "${platformName}" not available` };
    }

    const summary = summarizeEvent(event);
    try {
      await platform.send(chatId, summary);
    } catch (err) {
      return { decision: 'deny', reason: `humanChannel: send failed: ${err.message}` };
    }

    // Wait for the reply.
    const reply = await waitForReply(senderId, timeoutMs);
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
    const spent = event.context?.spent || {};
    const cap = event.context?.cap || {};
    const spendStr = spent.costUsd != null ? `$${spent.costUsd.toFixed(4)}` : '?';
    const capStr = cap.costUsd != null ? `$${cap.costUsd}` : '?';
    return [
      `[HALT] ${event.rule}: ${event.reason || ''}`,
      `Spent: ${spendStr} of ${capStr}`,
      `Reply "yes" to terminate, "no" to deny.`,
    ].join('\n');
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

function waitForReply(senderId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingHumanResponses.has(senderId)) {
        pendingHumanResponses.delete(senderId);
        resolve(null);
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    pendingHumanResponses.set(senderId, {
      resolve: (text) => {
        clearTimeout(timer);
        pendingHumanResponses.delete(senderId);
        resolve(text);
      },
    });
  });
}

/** Called from the message router when a paired user replies. Returns true if consumed. */
function handleHumanReply(senderId, text) {
  const pending = pendingHumanResponses.get(senderId);
  if (!pending) return false;
  pending.resolve(text);
  return true;
}

function hasPendingHumanReply(senderId) {
  return pendingHumanResponses.has(senderId);
}

function _clearAllPending() {
  for (const [, p] of pendingHumanResponses) p.resolve(null);
  pendingHumanResponses.clear();
}

module.exports = {
  createHumanPrompt,
  handleHumanReply,
  hasPendingHumanReply,
  _clearAllPending,
};
