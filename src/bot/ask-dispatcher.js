'use strict';

/**
 * The one owner-ask dispatcher (M10 — owner-ask gate redesign, §3).
 *
 * "The bot needs something from the owner and must pause until they reply" was
 * implemented four times with no shared contract (slash ceremony, LLM ceremony,
 * a 7-case router switch, and ad-hoc memory writes). The seam between them leaked
 * the "stuck on delete" replay bug: a parked request recorded with no ending.
 *
 * This module is the single lifecycle every owner-ask runs through. An ask is a
 * plain object of one shape:
 *
 *   {
 *     showPrompt() -> 'prompted' | 'locked' | 'no-channel' | <other>   // sends its prompt
 *     accepts(text) -> boolean                                          // is this a valid answer?
 *     handle(text) -> { done, summary } | { retry } | { next: <ask> }   // resolve one step
 *     request?      // the conversational user text to record at completion (LLM door);
 *                   // null for slash commands (a command is not conversation)
 *     label?, ttlMs?, expireMsg?, isOwner?, stickHint?
 *   }
 *
 * The dispatcher owns — once, for every ask type — the three things that were
 * copy-pasted or missing:
 *   - cancel  ("cancel/stop/abort/no")  -> clear + record "cancelled — didn't run"
 *   - stick   (anything that isn't an answer or cancel) -> "⏳ still waiting", ask stays
 *   - record  (on done/cancel/expire)   -> write (request -> summary) into recent.json
 *
 * Recording the outcome in ONE place is what fixes the replay bug for all types at
 * once: a completed turn enters conversation as a paired (request -> outcome), and a
 * pending ask records nothing — so no ending can leave a dangling request. The PIN
 * keystrokes and the prompt text are NEVER recorded (transient mechanics only).
 *
 * The dispatcher is deliberately I/O-injected: `platform` (send) and `getMem`
 * (recall the per-chat memory manager) are passed in, so it is unit-testable with
 * no bot stack. The ask's `handle`/`showPrompt` own all capability-specific chat
 * output; the dispatcher owns only the lifecycle and the conversation record.
 */

const ASK_KIND = 'ask';
const CANCEL_RE = /^(cancel|stop|abort|no)$/i;

/**
 * Record a completed exchange (request -> outcome) into conversation memory.
 * Only when the ask carried a conversational request (the LLM door). Slash-door
 * asks carry no request -> nothing is recorded (a command is not conversation).
 * The PIN keystrokes and prompts are NEVER passed here — only the clean summary.
 */
function recordOutcome(entry, summary, getMem) {
  if (!entry.request || typeof getMem !== 'function') return;
  const mem = getMem(entry.chatId, { isAdmin: !!entry.isOwner });
  if (!mem) return;
  mem.appendMessage('user', entry.request);
  mem.appendToLog('user', entry.request);
  const line = summary == null ? '' : String(summary).trim();
  if (line) {
    mem.appendMessage('assistant', line);
    mem.appendToLog('assistant', line);
  }
}

/** Build the PendingRegistry payload for a parked ask (one place, so re-park on
 *  retry/next carries the same lifecycle metadata as the original open). */
function askEntry(ask, { chatId, senderId, request }) {
  return {
    ask,
    request: request ?? ask.request ?? null,
    label: ask.label ?? null,
    isOwner: !!ask.isOwner,
    chatId, senderId,
    ttlMs: ask.ttlMs,
    expireMsg: ask.expireMsg,
    // Optional reply gate (the router checks entry.match before dispatching): an
    // ask whose answers have a fixed shape (e.g. pin_change → 4–6 digits) carries
    // it so a non-matching message falls through to normal routing instead of
    // being consumed. Most asks omit it → every reply enters the dispatcher.
    match: ask.match,
  };
}

/**
 * Open an ask: show its prompt, and on success park it on the registry. Returns
 * the prompt status. ONLY 'prompted' parks — any other status fails closed
 * (nothing parked -> the action never runs). The dispatcher sends NOTHING on a
 * failed prompt; the door interprets a non-'prompted' status itself (the slash
 * door messages the owner, the LLM door returns a tool-result string for the
 * model to report) — preserving each door's exact prior wording.
 */
async function openAsk(ask, { pending, chatId, senderId }) {
  // showPrompt is optional: an ask whose prompt the caller already sent (e.g. a
  // mode/business picker rendered from a per-call chat list) omits it → treated as
  // 'prompted' and simply parked.
  const status = ask.showPrompt ? await ask.showPrompt() : 'prompted';
  if (status !== 'prompted') return status;
  pending.set(chatId, senderId, ASK_KIND, askEntry(ask, { chatId, senderId }));
  return 'prompted';
}

/**
 * Resume a parked ask with the owner's reply. The single place an ask cancels,
 * sticks, advances, retries, or completes — and the single place a completion is
 * recorded. `handle`/`showPrompt` already own the capability-specific chat output;
 * this owns lifecycle + recording only.
 */
async function resumeAsk(entry, text, { pending, platform, getMem, chatId, senderId }) {
  const ask = entry.ask;
  const t = String(text || '').trim();

  // command-cancel (opt-in) — a /command abandons the ask AND routes normally, so an
  // owner can escape a picker by issuing the next command (the pickers' prior UX).
  // Returns { fallThrough } so the router continues to command routing. Off by
  // default: the PIN ceremony deliberately STICKS on a stray /command (fail-safe).
  if (ask.commandCancels && t.startsWith('/')) {
    pending.clear(chatId, senderId);
    recordOutcome(entry, 'cancelled — didn\'t run', getMem);
    if (ask.cancelMsg) { try { await platform.send(chatId, ask.cancelMsg); } catch { /* best-effort */ } }
    return { fallThrough: true };
  }

  // cancel — uniform across every ask type.
  if (CANCEL_RE.test(t)) {
    pending.clear(chatId, senderId);
    recordOutcome(entry, 'cancelled — didn\'t run', getMem);
    try { await platform.send(chatId, ask.cancelMsg || 'Cancelled — that action will not run.'); } catch { /* best-effort */ }
    return;
  }

  // stick — not an answer and not a cancel -> remind, keep the ask parked. This is
  // the owner invariant: one ask at a time; a stray message neither runs unguarded
  // nor burns the ask. An ask may override the wording via stickMsg.
  if (!ask.accepts(t)) {
    if (ask.stickMsg) {
      try { await platform.send(chatId, ask.stickMsg); } catch { /* best-effort */ }
    } else {
      const what = entry.label ? ` to ${entry.label}` : '';
      const hint = ask.stickHint ? ` ${ask.stickHint}` : '';
      try { await platform.send(chatId, `⏳ Still waiting${what}.${hint}`); } catch { /* best-effort */ }
    }
    return;
  }

  // a valid answer -> clear first (idempotent: a re-entrant reply can't double-run),
  // then handle. handle returns exactly one outcome.
  pending.clear(chatId, senderId);
  const outcome = (await ask.handle(t)) || {};

  // multi-step -> advance to the next step, stay pending. No record yet.
  if (outcome.next) {
    pending.set(chatId, senderId, ASK_KIND, askEntry(outcome.next, { chatId, senderId, request: entry.request }));
    return;
  }

  // retryable (wrong PIN, attempts remain) -> re-park the SAME ask. handle already
  // sent the reprompt ("Wrong PIN, N left"). No record — the action hasn't ended.
  if (outcome.retry) {
    pending.set(chatId, senderId, ASK_KIND, askEntry(ask, { chatId, senderId, request: entry.request }));
    return;
  }

  // done (terminal) -> record (request -> summary). handle already sent the
  // user-facing result. Recording here fixes the replay bug for every type.
  recordOutcome(entry, outcome.summary, getMem);
}

/**
 * An ask expired (the owner never replied within its TTL). The registry already
 * deleted the entry (get -> { expired:true }); record the terminal "expired"
 * outcome so the request doesn't dangle, and announce it once.
 */
async function expireAsk(entry, { platform, getMem, chatId }) {
  recordOutcome(entry, 'expired — didn\'t run', getMem);
  try {
    await platform.send(chatId, entry.expireMsg || 'That prompt expired — please re-send the command.');
  } catch { /* best-effort */ }
}

module.exports = { ASK_KIND, openAsk, resumeAsk, expireAsk, recordOutcome };
