const { loadConfig, ensureMultisDir, PATHS } = require('./config');
const { logAudit } = require('./governance/audit');
const { createMessageRouter } = require('./bot/handlers');
const { TelegramPlatform } = require('./platforms/telegram');
const { BeeperPlatform } = require('./platforms/beeper');
const { cleanupLogs } = require('./maintenance/cleanup');
const context = require('./context');
const fs = require('fs');
const path = require('path');

async function main() {
  ensureMultisDir();
  const config = loadConfig();

  console.log(`multis v${require('../package.json').version}`);
  console.log(`Pairing code: ${config.pairing_code}`);
  console.log(`Paired users: ${config.allowed_users.length}`);
  console.log(`LLM provider: ${config.llm.provider}`);

  // Bring up litectx (process-wide doc + memory store) before the router/platforms.
  // embeddings: semantic recall (R4) on unless config.memory.semantic === false (loads a model ~2s).
  await context.init({ documents: config.documents, embeddings: config.memory?.semantic !== false });
  context.setBounds(config.documents);

  const handler = createMessageRouter(config);
  const platforms = [];

  // Telegram — enabled by default (backward compat)
  if (config.platforms?.telegram?.enabled !== false) {
    try {
      const telegram = new TelegramPlatform(config);
      telegram.onMessage(handler);
      handler.registerPlatform('telegram', telegram);
      platforms.push(telegram);
    } catch (err) {
      console.error(`Telegram: ${err.message}`);
    }
  }

  // Beeper — opt-in
  if (config.platforms?.beeper?.enabled) {
    try {
      const beeper = new BeeperPlatform(config);
      beeper.onMessage(handler);
      handler.registerPlatform('beeper', beeper);
      platforms.push(beeper);
    } catch (err) {
      console.error(`Beeper: ${err.message}`);
    }
  }

  if (platforms.length === 0) {
    console.error('No platforms configured. Set up at least one platform.');
    process.exit(1);
  }

  // Initialize scheduler after platforms registered (centralized tick handler)
  handler.initScheduler();

  logAudit({ action: 'bot_start', platforms: platforms.map(p => p.name), paired_users: config.allowed_users.length });

  for (const p of platforms) {
    const ok = await p.start();
    if (ok === false && p.name === 'beeper') {
      console.warn('⚠ Beeper Desktop not reachable. Start Beeper Desktop and restart multis.');
    }
  }

  console.log(`Running on: ${platforms.map(p => p.name).join(', ')}`);

  // Write PID file for daemon management
  const pidDir = path.dirname(PATHS.pid());
  if (!fs.existsSync(pidDir)) fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(PATHS.pid(), String(process.pid));

  // Run cleanup on startup. Memory retention is enforced at write time via
  // per-row expiresAt (admin rows live longer — see capture.js); purge() just
  // reclaims whatever has expired. Log files are pruned separately by age.
  try {
    const logResult = cleanupLogs(config.memory?.log_retention_days || 30);
    const purged = await context.purge();
    if (logResult.deleted > 0 || purged > 0) {
      console.log(`Cleanup: ${logResult.deleted} old logs, ${purged} expired memory rows removed`);
    }
  } catch (err) {
    console.warn(`Cleanup warning: ${err.message}`);
  }

  // Schedule daily cleanup
  const DAILY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    (async () => {
      try {
        cleanupLogs(config.memory?.log_retention_days || 30);
        await context.purge();
      } catch (err) {
        console.warn(`Scheduled cleanup error: ${err.message}`);
      }
    })();
  }, DAILY_MS);

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\nShutting down (${signal})...`);
    logAudit({ action: 'bot_stop', reason: signal });
    // Remove PID file
    try { fs.unlinkSync(PATHS.pid()); } catch { /* ignore */ }
    for (const p of platforms) {
      await p.stop();
    }
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Catch unhandled errors so daemon doesn't die silently
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err?.message || err);
    logAudit({ action: 'unhandled_rejection', error: String(err?.message || err) });
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err?.message || err);
    logAudit({ action: 'uncaught_exception', error: String(err?.message || err) });
    // uncaughtException: process state may be corrupt, exit after logging
    process.exit(1);
  });
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
