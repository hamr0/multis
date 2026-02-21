/**
 * Checkpoint integration — human approval gate for irreversible tool actions.
 * Reuses the pendingAuth Map pattern from PIN auth for platform reply interception.
 */

const { Checkpoint } = require('bare-agent');

// Pending approval requests: senderId → { resolve, reject, timeout }
const pendingApprovals = new Map();

/**
 * Create a bareagent Checkpoint wired to a chat platform.
 * @param {Object} platform — platform adapter with send()
 * @param {string} chatId — chat to send approval requests to
 * @param {string} senderId — user who must approve
 * @param {Object} config — config.security.checkpoint_tools
 * @returns {Checkpoint}
 */
function createCheckpoint(platform, chatId, senderId, config) {
  const tools = config?.security?.checkpoint_tools || ['exec'];
  const timeoutMs = (config?.security?.checkpoint_timeout || 60) * 1000;

  return new Checkpoint({
    tools,
    send: async (question) => {
      await platform.send(chatId, `Approval needed: ${question}\nReply "yes" or "no".`);
    },
    waitForReply: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(senderId);
        reject(new Error('Approval timed out'));
      }, timeoutMs);

      pendingApprovals.set(senderId, {
        resolve: (answer) => {
          clearTimeout(timer);
          pendingApprovals.delete(senderId);
          resolve(answer);
        },
        reject: (err) => {
          clearTimeout(timer);
          pendingApprovals.delete(senderId);
          reject(err);
        },
        timeout: timer
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
