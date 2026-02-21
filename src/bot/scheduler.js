/**
 * Scheduler integration — wraps bareagent Scheduler for /remind, /cron, /jobs, /cancel.
 * Jobs persist to ~/.multis/data/scheduler.json.
 */

const path = require('path');
const { Scheduler } = require('bare-agent');
const { getMultisDir } = require('../config');

let _scheduler = null;

/**
 * Get or create the singleton scheduler.
 * @param {Function} onTick — async (job) => void, called when a job fires
 * @returns {Scheduler}
 */
function getScheduler(onTick) {
  if (!_scheduler) {
    _scheduler = new Scheduler({
      file: path.join(getMultisDir(), 'data', 'scheduler.json'),
      interval: 60000,
      onError: (err, job) => console.error(`[scheduler] Job ${job.id} error: ${err.message}`),
    });
    if (onTick) _scheduler.start(onTick);
  }
  return _scheduler;
}

/**
 * Parse /remind args: "<duration> <action>"
 * Duration: 1m, 5m, 30m, 1h, 2h, 1d, etc.
 * @returns {{ schedule: string, action: string } | null}
 */
function parseRemind(args) {
  if (!args) return null;
  const match = args.match(/^(\d+[smhd])\s+(.+)$/i);
  if (!match) return null;
  return { schedule: match[1], action: match[2] };
}

/**
 * Parse /cron args: "<cron-expression> <action>"
 * Cron: 5 space-separated fields + action text.
 * @returns {{ schedule: string, action: string } | null}
 */
function parseCron(args) {
  if (!args) return null;
  // Cron has 5 fields: min hour dom month dow
  const match = args.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
  if (!match) return null;
  return { schedule: match[1], action: match[2] };
}

/**
 * Format a job for display.
 */
function formatJob(job) {
  const type = job.type === 'recurring' ? 'recurring' : 'one-shot';
  return `[${job.id}] ${type} | ${job.schedule} | ${job.action}`;
}

module.exports = { getScheduler, parseRemind, parseCron, formatJob };
