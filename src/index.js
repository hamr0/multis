const { loadConfig, ensureMultisDir, PATHS } = require('./config');
const { logAudit } = require('./governance/audit');
const { createMessageRouter } = require('./bot/handlers');
const { TelegramPlatform } = require('./platforms/telegram');
const { BeeperPlatform } = require('./platforms/beeper');
const { cleanupLogs, pruneMemoryChunks } = require('./maintenance/cleanup');
const { DocumentStore } = require('./indexer/store');
const fs = require('fs');
const path = require('path');

async function main() {
  ensureMultisDir();
  const config = loadConfig();

  console.log('multis v0.1.0');
  console.log(`Pairing code: ${config.pairing_code}`);
  console.log(`Paired users: ${config.allowed_users.length}`);
  console.log(`LLM provider: ${config.llm.provider}`);

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

  logAudit({ action: 'bot_start', platforms: platforms.map(p => p.name), paired_users: config.allowed_users.length });

  for (const p of platforms) {
    await p.start();
  }

  console.log(`Running on: ${platforms.map(p => p.name).join(', ')}`);

  // Write PID file for daemon management
  const pidDir = path.dirname(PATHS.pid());
  if (!fs.existsSync(pidDir)) fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(PATHS.pid(), String(process.pid));

  // Run cleanup on startup
  try {
    const store = new DocumentStore();
    const logDays = config.memory?.log_retention_days || 30;
    const memDays = config.memory?.retention_days || 90;
    const adminDays = config.memory?.admin_retention_days || 365;
    const logResult = cleanupLogs(logDays);
    const chunksPruned = pruneMemoryChunks(store, memDays, adminDays);
    if (logResult.deleted > 0 || chunksPruned > 0) {
      console.log(`Cleanup: ${logResult.deleted} old logs, ${chunksPruned} old chunks removed`);
    }
    store.close();
  } catch (err) {
    console.warn(`Cleanup warning: ${err.message}`);
  }

  // Schedule daily cleanup
  const DAILY_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    try {
      const store = new DocumentStore();
      cleanupLogs(config.memory?.log_retention_days || 30);
      pruneMemoryChunks(store, config.memory?.retention_days || 90, config.memory?.admin_retention_days || 365);
      store.close();
    } catch (err) {
      console.warn(`Scheduled cleanup error: ${err.message}`);
    }
  }, DAILY_MS);

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\nShutting down (${signal})...`);
    logAudit({ action: 'bot_stop', reason: signal });
    // Remove PID file
    try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
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
