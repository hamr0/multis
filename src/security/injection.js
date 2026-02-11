const fs = require('fs');
const path = require('path');
const { MULTIS_DIR } = require('../config');

const AUDIT_PATH = path.join(MULTIS_DIR, 'prompt_injection_audit.log');

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous\s+)?instructions/i,
  /ignore\s+your\s+(instructions|rules|guidelines)/i,
  /disregard\s+(all\s+)?(previous\s+)?instructions/i,
  /system\s+prompt/i,
  /show\s+(me\s+)?(all|other)\s+(users?|customers?|data)/i,
  /act\s+as\s+(an?\s+)?admin/i,
  /pretend\s+(you('re| are)\s+)?(an?\s+)?admin/i,
  /you\s+are\s+now\s+(an?\s+)?/i,
  /\bDAN\b/,
  /jailbreak/i,
  /bypass\s+(security|restrictions|filters)/i,
  /reveal\s+(your|the)\s+(system|hidden|secret)/i,
];

/**
 * Check text for prompt injection patterns.
 * @returns {{ flagged: boolean, patterns: string[] }}
 */
function detectInjection(text) {
  const matched = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      matched.push(pattern.source);
    }
  }
  return { flagged: matched.length > 0, patterns: matched };
}

/**
 * Log a prompt injection attempt to dedicated audit file.
 */
function logInjectionAttempt(entry) {
  const dir = path.dirname(AUDIT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry
  }) + '\n';
  fs.appendFileSync(AUDIT_PATH, line);
}

module.exports = { detectInjection, logInjectionAttempt };
