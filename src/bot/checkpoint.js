/**
 * Checkpoint integration — human approval gate for irreversible tool actions.
 * Uses bareagent v0.7.0's built-in Checkpoint timeout (no custom timer needed).
 * Reuses the pendingAuth Map pattern from PIN auth for platform reply interception.
 */

const { Checkpoint } = require('bare-agent');

// Pending approval requests: senderId → { resolve }
const pendingApprovals = new Map();

/**
 * Create a bareagent Checkpoint wired to a chat platform.
 * Timeout is handled by bareagent's Checkpoint({ timeout }) — on expiry it throws
 * TimeoutError, Loop catches it and auto-denies with reason via loop:error + onError.
 */
function createCheckpoint(platform, chatId, senderId, config) {
  const tools = config?.security?.checkpoint_tools || ['exec'];
  const timeoutMs = (config?.security?.checkpoint_timeout || 60) * 1000;

  return new Checkpoint({
    tools,
    timeout: timeoutMs,
    send: async (question) => {
      await platform.send(chatId, `Approval needed: ${question}\nReply "yes" or "no".`);
    },
    waitForReply: () => new Promise((resolve) => {
      pendingApprovals.set(senderId, {
        resolve: (answer) => {
          pendingApprovals.delete(senderId);
          resolve(answer);
        },
      });
    }),
  });
}

/**
 * Check if a user has a pending approval and handle their reply.
 * @returns {boolean} — true if the message was consumed as an approval reply
 */
function handleApprovalReply(senderId, text) {
  const pending = pendingApprovals.get(senderId);
  if (!pending) return false;

  const answer = text.trim().toLowerCase();
  if (answer === 'yes' || answer === 'y') {
    pending.resolve('yes');
    return true;
  } else if (answer === 'no' || answer === 'n') {
    pending.resolve('no');
    return true;
  }
  return false;
}

/**
 * Check if a user has a pending approval.
 */
function hasPendingApproval(senderId) {
  return pendingApprovals.has(senderId);
}

module.exports = { createCheckpoint, handleApprovalReply, hasPendingApproval };
