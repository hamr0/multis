const { loadConfig, ensureMultisDir } = require('./config');
const { logAudit } = require('./governance/audit');
const { createMessageRouter } = require('./bot/handlers');
const { TelegramPlatform } = require('./platforms/telegram');
const { BeeperPlatform } = require('./platforms/beeper');

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

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\nShutting down (${signal})...`);
    logAudit({ action: 'bot_stop', reason: signal });
    for (const p of platforms) {
      await p.stop();
    }
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
