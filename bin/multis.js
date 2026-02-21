#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const { PATHS, getMultisDir } = require('../src/config');
const MULTIS_DIR = getMultisDir();
const PID_PATH = PATHS.pid();
const CONFIG_PATH = PATHS.config();
const SRC_INDEX = path.join(__dirname, '..', 'src', 'index.js');

const LOGO = [
  '  ╭────────────────────╮',
  '  │  ╔╦╗╦ ╦╦ ╔╦╗╦╔═╗   │',
  '  │  ║║║║ ║║  ║ ║╚═╗   │',
  '  │  ╩ ╩╚═╝╩═╝╩ ╩╚═╝   │',
  '  ╰──╮─────────────────╯',
  '     ╰── v' + JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).version,
].join('\n');

const command = process.argv[2];

if (command) {
  // Direct command mode: multis start, multis stop, etc.
  runCommand(command);
} else {
  // Interactive menu mode: just `multis`
  runMenu();
}

function runCommand(cmd) {
  switch (cmd) {
    case 'init':    runInit(); break;
    case 'start':   runStart(); break;
    case 'stop':    runStop(); break;
    case 'restart': runRestart(); break;
    case 'status':  runStatus(); break;
    case 'doctor':  runDoctor(); break;
    default:
      console.log(`\x1b[31mUnknown command: ${cmd}\x1b[0m\n`);
      console.log('Usage: multis <init|start|stop|restart|status|doctor>');
      console.log('   or: multis  (interactive menu)');
      process.exit(1);
  }
}

async function runMenu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
  const dim  = (s) => `\x1b[2m${s}\x1b[0m`;
  const green = (s) => `\x1b[32m${s}\x1b[0m`;
  const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

  console.log('\n' + LOGO + '\n');

  // Quick status
  const running = isRunning();
  const hasConfig = fs.existsSync(CONFIG_PATH);
  if (!hasConfig) {
    console.log(`Status: ${yellow('not configured')}\n`);
  } else if (running) {
    const pid = fs.readFileSync(PID_PATH, 'utf-8').trim();
    console.log(`Status: ${green('running')} ${dim(`(PID ${pid})`)}\n`);
  } else {
    console.log(`Status: ${yellow('stopped')}\n`);
  }

  console.log('  1) init      Set up multis (interactive wizard)');
  console.log('  2) start     Start daemon in background');
  console.log('  3) stop      Stop running daemon');
  console.log('  4) restart   Stop + start (or just start if not running)');
  console.log('  5) doctor    Run diagnostic checks');
  console.log('  0) exit      Quit this menu\n');

  const choice = (await ask('Choose (0-5): ')).trim();
  rl.close();

  const commands = { '1': 'init', '2': 'start', '3': 'stop', '4': 'restart', '5': 'doctor' };
  if (choice === '0' || choice === '') {
    console.log('Bye.');
    process.exit(0);
  }
  const cmd = commands[choice];
  if (!cmd) {
    console.log(`Invalid choice: ${choice}`);
    process.exit(1);
  }
  console.log('');
  runCommand(cmd);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

const LLM_DEFAULTS = {
  anthropic: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  openai:    { provider: 'openai', model: 'gpt-4o-mini' },
  ollama:    { provider: 'ollama', model: 'llama3.1:8b', baseUrl: 'http://localhost:11434' }
};

async function runInit() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  // ANSI colors
  const c = {
    bold:    (s) => `\x1b[1m${s}\x1b[0m`,
    green:   (s) => `\x1b[32m${s}\x1b[0m`,
    yellow:  (s) => `\x1b[33m${s}\x1b[0m`,
    cyan:    (s) => `\x1b[36m${s}\x1b[0m`,
    dim:     (s) => `\x1b[2m${s}\x1b[0m`,
    ok:      (s) => `\x1b[32m✓\x1b[0m ${s}`,
    warn:    (s) => `\x1b[33m!\x1b[0m ${s}`,
    fail:    (s) => `\x1b[31m✗\x1b[0m ${s}`,
  };
  const step = (n, total, title) => console.log(`\n${c.bold(`Step ${n}/${total}`)}  ${c.cyan(title)}\n`);

  // Track what was set up for the summary
  const summary = { telegram: null, beeper: null, beeperAccounts: [], llm: null, pin: false };
  const TOTAL_STEPS = 4;

  console.log(c.bold('\nmultis init') + ' — interactive setup\n');

  // Ensure directory
  if (!fs.existsSync(MULTIS_DIR)) {
    fs.mkdirSync(MULTIS_DIR, { recursive: true });
  }

  // Load existing or create fresh config
  let config = {};
  const templatePath = path.join(__dirname, '..', '.multis-template', 'config.json');
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    const profile = config.bot_mode === 'business' ? 'Business chatbot' : 'Personal assistant';
    const plats = [
      config.platforms?.telegram?.enabled && 'Telegram',
      config.platforms?.beeper?.enabled && 'Beeper',
    ].filter(Boolean).join(' + ') || 'no platforms';
    const llmName = config.llm?.provider || 'no LLM';
    console.log(c.dim(`Existing config: ${profile} (${plats}), ${llmName} — updating.\n`));
  } else if (fs.existsSync(templatePath)) {
    config = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  }

  // -----------------------------------------------------------------------
  // Step 1: What do you need?
  // -----------------------------------------------------------------------
  step(1, TOTAL_STEPS, 'What do you need?');

  let useTelegram = false;
  let useBeeper = false;

  // Check if we have a valid existing setup to offer Enter-to-keep
  const hasExistingSetup = config.bot_mode &&
    (config.platforms?.telegram?.enabled || config.platforms?.beeper?.enabled);

  if (hasExistingSetup) {
    const profile = config.bot_mode === 'business' ? 'Business chatbot' : 'Personal assistant';
    const plats = [
      config.platforms?.telegram?.enabled && 'Telegram',
      config.platforms?.beeper?.enabled && 'Beeper',
    ].filter(Boolean).join(' + ');
    console.log(`  Current: ${profile} (${plats})`);
    console.log('');
  }

  console.log('  1) Personal assistant (Telegram)');
  console.log('     ' + c.dim('Your private AI. Commands, docs, search.'));
  console.log('');
  console.log('  2) Personal assistant (Beeper) ' + c.dim('— recommended'));
  console.log('     ' + c.dim('Same, plus all your messengers archived and searchable.'));
  console.log('');
  console.log('  3) Business chatbot (Beeper)');
  console.log('     ' + c.dim('Auto-respond to customers across all channels.'));

  const step1Default = hasExistingSetup ? '' : '2';
  const step1Hint = hasExistingSetup ? 'Enter to keep, or choose 1/2/3' : '1/2/3';
  const setupChoice = (await ask(`\nChoose (${step1Hint}) [${step1Default || 'keep'}]: `)).trim() || step1Default;

  if (!setupChoice && hasExistingSetup) {
    // Keep existing setup
    useTelegram = !!config.platforms?.telegram?.enabled;
    useBeeper = !!config.platforms?.beeper?.enabled;
    const profile = config.bot_mode === 'business' ? 'Business chatbot' : 'Personal assistant';
    const plats = [useTelegram && 'Telegram', useBeeper && 'Beeper'].filter(Boolean).join(' + ');
    console.log(c.ok(`Keeping: ${plats}, ${config.bot_mode} mode`));
  } else {
    switch (setupChoice || '2') {
      case '1':
        useTelegram = true;
        config.bot_mode = 'personal';
        break;
      case '3': {
        useBeeper = true;
        config.bot_mode = 'business';
        const addTg = (await ask('\nAlso use Telegram as a second admin channel? (y/n) [n]: ')).trim().toLowerCase();
        if (addTg === 'y' || addTg === 'yes') useTelegram = true;
        break;
      }
      default: // '2' or anything else
        useBeeper = true;
        config.bot_mode = 'personal';
        break;
    }
    const platformNames = [useTelegram && 'Telegram', useBeeper && 'Beeper'].filter(Boolean).join(' + ');
    console.log(c.ok(`${platformNames}, ${config.bot_mode} mode`));
  }

  if (!config.platforms) config.platforms = {};
  summary.botMode = config.bot_mode;

  // -----------------------------------------------------------------------
  // Step 2: Platform connections
  // -----------------------------------------------------------------------
  step(2, TOTAL_STEPS, 'Connect Platforms');

  if (useTelegram) {
    console.log(c.bold('Telegram\n'));

    // Check if Telegram is already configured with a verified token
    const existingTgToken = config.telegram_bot_token || config.platforms?.telegram?.bot_token || '';
    const existingTgBot = config.platforms?.telegram?.bot_username || '';
    const existingOwner = config.owner_id || '';
    let skipTelegram = false;

    if (existingTgToken && existingTgBot) {
      const ownerStr = existingOwner ? ` owner: ${existingOwner}` : '';
      console.log(`  Telegram: @${existingTgBot}${ownerStr} ${c.green('✓')}`);
      const tgInput = (await ask('  [Enter to keep, or paste new token]: ')).trim();
      if (!tgInput) {
        skipTelegram = true;
        const ownerDisplay = existingOwner ? `ID ${existingOwner}` : null;
        summary.telegram = { bot: `@${existingTgBot}`, owner: ownerDisplay };
        console.log(c.ok('Keeping Telegram config'));
      }
    }

    if (!skipTelegram) {
      if (!existingTgBot) {
        console.log('Create a bot via @BotFather on Telegram:');
        console.log(c.dim('  1. Search @BotFather → /newbot → pick name → copy token\n'));
      }

      let token = '';
      let botUsername = '';
      while (!botUsername) {
        token = (await ask(`Bot token${existingTgToken ? ` [${existingTgToken.slice(0, 8)}...]` : ''}: `)).trim();
        if (!token && existingTgToken) token = existingTgToken;

        if (!token) {
          console.log(c.warn('Token required for Telegram. Try again.\n'));
          continue;
        }

        if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
          console.log(c.warn('Invalid format (expected digits:alphanumeric). Try again.\n'));
          continue;
        }

        console.log('Verifying token...');
        try {
          const { Telegraf } = require('telegraf');
          const testBot = new Telegraf(token);
          const me = await testBot.telegram.getMe();
          botUsername = me.username;
          console.log(c.ok(`Bot verified: @${botUsername}\n`));

          console.log(`Now send ${c.bold('/start')} to @${botUsername} in Telegram`);
          console.log(c.dim('Waiting up to 60 seconds...\n'));

          const paired = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              testBot.stop('timeout');
              resolve(null);
            }, 60000);

            testBot.start((ctx) => {
              clearTimeout(timeout);
              const userId = String(ctx.from.id);
              const username = ctx.from.username || ctx.from.first_name || userId;
              testBot.stop('paired');
              resolve({ userId, username });
            });

            testBot.launch({ dropPendingUpdates: true }).catch(() => {
              clearTimeout(timeout);
              resolve(null);
            });
          });

          if (paired) {
            config.owner_id = paired.userId;
            if (!config.allowed_users) config.allowed_users = [];
            if (!config.allowed_users.includes(paired.userId)) {
              config.allowed_users.push(paired.userId);
            }
            console.log(c.ok(`Paired as owner (@${paired.username})`));
            summary.telegram = { bot: `@${botUsername}`, owner: `@${paired.username}` };
          } else {
            console.log(c.warn('No /start received. You can pair later via /start <code>.'));
            summary.telegram = { bot: `@${botUsername}`, owner: null };
          }
        } catch (err) {
          console.log(c.fail(`Verification failed: ${err.message}`));
          const retry = (await ask('Try a different token? (Y/n): ')).trim().toLowerCase();
          if (retry === 'n') {
            summary.telegram = { bot: null, owner: null, error: 'token not verified' };
            break;
          }
          continue;
        }
      }

      config.telegram_bot_token = token;
      if (!config.platforms.telegram) config.platforms.telegram = {};
      config.platforms.telegram.bot_token = token;
      config.platforms.telegram.bot_username = botUsername;
      config.platforms.telegram.enabled = true;
    }
  } else {
    if (!config.platforms.telegram) config.platforms.telegram = {};
    config.platforms.telegram.enabled = false;
  }

  if (useBeeper) {
    console.log(`\n${c.bold('Beeper')}\n`);

    // Check if Beeper is already configured
    const existingBeeperEnabled = config.platforms?.beeper?.enabled;
    let skipBeeper = false;

    if (existingBeeperEnabled) {
      const beeperUrl = config.platforms.beeper.url || 'localhost:23373';
      console.log(`  Beeper: configured (${beeperUrl}) ${c.green('✓')}`);
      const beeperInput = (await ask('  [Enter to keep, or type "r" to reconfigure]: ')).trim().toLowerCase();
      if (!beeperInput) {
        skipBeeper = true;
        summary.beeper = 'connected (kept)';
        console.log(c.ok('Keeping Beeper config'));
      }
    }

    if (!skipBeeper) try {
      const beeper = require('../src/cli/setup-beeper');

      console.log('Checking Beeper Desktop API...');
      let reachable = await beeper.checkDesktop();

      if (!reachable) {
        console.log(c.warn('Not reachable at localhost:23373'));
        console.log(c.dim('  Make sure Beeper Desktop is open'));
        console.log(c.dim('  Settings > Developers > toggle on\n'));
        await ask('Press Enter to retry...');
        reachable = await beeper.checkDesktop();
      }

      if (reachable) {
        console.log(c.ok('Desktop API reachable'));

        // OAuth
        let token = null;
        const saved = beeper.loadToken();
        if (saved?.access_token) {
          try {
            await beeper.api(saved.access_token, 'GET', '/v1/accounts');
            token = saved.access_token;
          } catch {
            console.log(c.dim('Saved token expired, re-authenticating...'));
          }
        }

        if (!token) {
          console.log('Starting OAuth PKCE flow...');
          token = await beeper.oauthPKCE();
        }
        console.log(c.ok('Authenticated'));

        // List accounts
        const accounts = await beeper.api(token, 'GET', '/v1/accounts');
        const list = Array.isArray(accounts) ? accounts : accounts.items || [];
        for (const acc of list) {
          const name = acc.user?.displayText || acc.user?.id || acc.accountID || '?';
          const network = acc.network || '?';
          summary.beeperAccounts.push(`${network}: ${name}`);
        }

        if (!config.platforms) config.platforms = {};
        if (!config.platforms.beeper) config.platforms.beeper = {};
        config.platforms.beeper.enabled = true;
        config.platforms.beeper.url = config.platforms.beeper.url || 'http://localhost:23373';
        config.platforms.beeper.command_prefix = config.platforms.beeper.command_prefix || '/';
        config.platforms.beeper.poll_interval = config.platforms.beeper.poll_interval || 3000;

        // Auto-detect Telegram bot chat in Beeper (to exclude from polling)
        if (useTelegram && token) {
          try {
            const chatsData = await beeper.api(token, 'GET', '/v1/chats?limit=30');
            const beeperChats = chatsData.items || [];
            // Match by bot username (without @) in chat title
            const botName = (summary.telegram?.bot || '').replace('@', '').toLowerCase();
            if (botName) {
              const botChat = beeperChats.find(c =>
                (c.title || c.name || '').toLowerCase() === botName ||
                (c.title || c.name || '').toLowerCase() === botName.replace('bot', '')
              );
              if (botChat) {
                const botChatId = botChat.id || botChat.chatID;
                config.platforms.beeper.bot_chat_id = botChatId;
                console.log(c.ok(`Bot chat detected in Beeper: "${botChat.title || botChat.name}" — will be excluded from polling`));
              }
            }
          } catch { /* non-critical */ }
        }

        summary.beeper = 'connected';

        console.log(c.ok(`${list.length} account${list.length !== 1 ? 's' : ''} connected`));
        console.log(c.dim('  Note: Beeper Desktop must be running for multis to work'));
      } else {
        console.log(c.fail('Still not reachable. Skipping Beeper.'));
        summary.beeper = 'skipped';
      }
    } catch (err) {
      console.log(c.fail(`Beeper setup error: ${err.message}`));
      summary.beeper = `error: ${err.message}`;
    }
  } else {
    if (!config.platforms.beeper) config.platforms.beeper = {};
    config.platforms.beeper.enabled = false;
  }

  // -----------------------------------------------------------------------
  // Step 3: LLM provider
  // -----------------------------------------------------------------------
  step(3, TOTAL_STEPS, 'LLM Provider');

  if (!config.llm) config.llm = {};

  // Check if LLM is already configured
  const existingLLM = config.llm.provider && (config.llm.apiKey || config.llm.provider === 'ollama');
  let skipLLM = false;

  if (existingLLM) {
    const providerName = config.llm.provider.charAt(0).toUpperCase() + config.llm.provider.slice(1);
    const modelName = config.llm.model || 'default';
    console.log(`  LLM: ${providerName} (${modelName}) ${c.green('✓')}`);
    console.log('');
  }

  console.log('Which LLM provider?');
  console.log('  1) Anthropic (Claude)');
  console.log('  2) OpenAI (GPT)');
  console.log('  3) OpenAI-compatible (OpenRouter, Together, Groq, etc.)');
  console.log('  4) Ollama (local, free, no API key)');

  const llmHint = existingLLM ? 'Enter to keep, or choose 1/2/3/4' : '1/2/3/4';
  const llmDefault = existingLLM ? '' : '1';
  const llmChoice = (await ask(`\nChoose (${llmHint}) [${llmDefault || 'keep'}]: `)).trim() || llmDefault;

  if (!llmChoice && existingLLM) {
    skipLLM = true;
    const providerName = config.llm.provider.charAt(0).toUpperCase() + config.llm.provider.slice(1);
    summary.llm = { provider: providerName, model: config.llm.model, verified: true };
    console.log(c.ok(`Keeping: ${providerName} (${config.llm.model})`));
  }

  if (!skipLLM) switch (llmChoice || '1') {
    case '1': { // Anthropic
      const defaults = LLM_DEFAULTS.anthropic;
      config.llm.provider = defaults.provider;
      config.llm.model = defaults.model;
      config.llm.baseUrl = '';

      const currentKey = config.llm.apiKey || '';
      let verified = false;
      while (!verified) {
        const key = (await ask(`Anthropic API key${currentKey ? ' [configured]' : ''}: `)).trim();
        if (key) config.llm.apiKey = key;
        else if (!currentKey) { console.log(c.warn('API key required.')); continue; }

        console.log('Verifying...');
        try {
          await verifyLLM(config.llm);
          console.log(c.ok(`Anthropic verified (${config.llm.model})`));
          verified = true;
        } catch (err) {
          console.log(c.fail(`Verification failed: ${err.message}`));
          const retry = (await ask('Try again? (Y/n): ')).trim().toLowerCase();
          if (retry === 'n') break;
        }
      }
      summary.llm = { provider: 'Anthropic', model: config.llm.model, verified };
      break;
    }

    case '2': { // OpenAI
      const defaults = LLM_DEFAULTS.openai;
      config.llm.provider = defaults.provider;
      config.llm.model = defaults.model;
      config.llm.baseUrl = '';

      const currentKey = config.llm.apiKey || '';
      let verified = false;
      while (!verified) {
        const key = (await ask(`OpenAI API key${currentKey ? ' [configured]' : ''}: `)).trim();
        if (key) config.llm.apiKey = key;
        else if (!currentKey) { console.log(c.warn('API key required.')); continue; }

        console.log('Verifying...');
        try {
          await verifyLLM(config.llm);
          console.log(c.ok(`OpenAI verified (${config.llm.model})`));
          verified = true;
        } catch (err) {
          console.log(c.fail(`Verification failed: ${err.message}`));
          const retry = (await ask('Try again? (Y/n): ')).trim().toLowerCase();
          if (retry === 'n') break;
        }
      }
      summary.llm = { provider: 'OpenAI', model: config.llm.model, verified };
      break;
    }

    case '3': { // OpenAI-compatible
      config.llm.provider = 'openai';

      const baseUrl = (await ask('Base URL (e.g. https://openrouter.ai/api/v1): ')).trim();
      const model = (await ask('Model name (e.g. google/gemini-2.0-flash): ')).trim();

      config.llm.baseUrl = baseUrl;
      config.llm.model = model || 'gpt-4o-mini';

      let verified = false;
      while (!verified) {
        const key = (await ask('API key: ')).trim();
        if (key) config.llm.apiKey = key;
        else { console.log(c.warn('API key required.')); continue; }

        console.log('Verifying...');
        try {
          await verifyLLM(config.llm);
          console.log(c.ok(`Verified (${config.llm.model})`));
          verified = true;
        } catch (err) {
          console.log(c.fail(`Verification failed: ${err.message}`));
          const retry = (await ask('Try again? (Y/n): ')).trim().toLowerCase();
          if (retry === 'n') break;
        }
      }

      let displayName = 'OpenAI-compatible';
      try { displayName = new URL(baseUrl).hostname.replace('www.', ''); } catch { /* */ }
      summary.llm = { provider: displayName, model: config.llm.model, verified };
      break;
    }

    case '4': { // Ollama
      const defaults = LLM_DEFAULTS.ollama;
      config.llm.provider = defaults.provider;
      config.llm.model = defaults.model;
      config.llm.baseUrl = defaults.baseUrl;
      config.llm.apiKey = '';

      console.log('Checking Ollama at localhost:11434...');
      let ollamaOk = false;
      try {
        await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        console.log(c.ok('Ollama is running'));
        ollamaOk = true;
      } catch {
        console.log(c.fail('Ollama not reachable — install from https://ollama.com'));
        console.log(c.dim('Config saved. Start Ollama before running multis.'));
      }
      summary.llm = { provider: 'Ollama', model: config.llm.model, verified: ollamaOk };
      break;
    }

    default:
      console.log(c.warn('Invalid choice, defaulting to Anthropic.'));
      config.llm.provider = 'anthropic';
      config.llm.model = LLM_DEFAULTS.anthropic.model;
      summary.llm = { provider: 'Anthropic', model: config.llm.model, verified: false };
  }

  // -----------------------------------------------------------------------
  // Step 4: Security
  // -----------------------------------------------------------------------
  step(4, TOTAL_STEPS, 'Security');

  const existingPin = !!config.security?.pin_hash;

  if (existingPin) {
    console.log(`  PIN: set ${c.green('✓')}`);
    const pinInput = (await ask('  [Enter to keep, or type new 4-6 digit PIN]: ')).trim();
    if (!pinInput) {
      console.log(c.ok('Keeping PIN'));
      summary.pin = true;
    } else if (/^\d{4,6}$/.test(pinInput)) {
      config.security.pin_hash = crypto.createHash('sha256').update(pinInput).digest('hex');
      console.log(c.ok('PIN updated'));
      summary.pin = true;
    } else {
      console.log(c.warn('Invalid PIN (must be 4-6 digits). Keeping existing.'));
      summary.pin = true;
    }
  } else {
    const pinChoice = (await ask('Set a PIN for sensitive commands like /exec? (4-6 digits, Enter to skip): ')).trim();
    if (pinChoice && /^\d{4,6}$/.test(pinChoice)) {
      if (!config.security) config.security = {};
      config.security.pin_hash = crypto.createHash('sha256').update(pinChoice).digest('hex');
      console.log(c.ok('PIN set'));
      summary.pin = true;
    } else if (pinChoice) {
      console.log(c.warn('Invalid PIN (must be 4-6 digits). Skipping.'));
    } else {
      console.log(c.dim('No PIN set (optional).'));
    }
  }

  // -----------------------------------------------------------------------
  // Save + Summary
  // -----------------------------------------------------------------------

  // Ensure pairing code
  if (!config.pairing_code) {
    config.pairing_code = crypto.randomBytes(3).toString('hex').toUpperCase();
  }
  if (!config.allowed_users) config.allowed_users = [];

  // Save
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  // Copy governance template if not present
  const govPath = PATHS.governance();
  const govTemplate = path.join(__dirname, '..', '.multis-template', 'governance.json');
  if (!fs.existsSync(govPath) && fs.existsSync(govTemplate)) {
    fs.mkdirSync(path.dirname(govPath), { recursive: true });
    fs.copyFileSync(govTemplate, govPath);
  }

  // Copy tools template if not present
  const toolsPath = PATHS.tools();
  const toolsTemplate = path.join(__dirname, '..', '.multis-template', 'tools.json');
  if (!fs.existsSync(toolsPath) && fs.existsSync(toolsTemplate)) {
    fs.copyFileSync(toolsTemplate, toolsPath);
  }

  // --- Final summary ---
  console.log(`\n${c.bold('Setup Complete')}\n`);

  const rows = [];
  rows.push(['Mode', config.bot_mode]);

  // Telegram
  if (summary.telegram) {
    if (summary.telegram.error) {
      rows.push(['Telegram', c.yellow(summary.telegram.error)]);
    } else {
      let tgVal = summary.telegram.bot || 'not configured';
      if (summary.telegram.owner) tgVal += ` ${c.dim('owner:')} ${summary.telegram.owner}`;
      else tgVal += ` ${c.dim('(not yet paired)')}`;
      rows.push(['Telegram', tgVal]);
    }
  }

  // Beeper + accounts
  if (summary.beeper) {
    rows.push(['Beeper', summary.beeper]);
    for (const acc of summary.beeperAccounts) {
      rows.push(['', c.dim(acc)]);
    }
  }

  // LLM
  if (summary.llm) {
    const llmStatus = summary.llm.verified ? c.green('verified') : c.yellow('not verified');
    rows.push(['LLM', `${summary.llm.provider} (${summary.llm.model}) — ${llmStatus}`]);
  }

  // PIN
  rows.push(['PIN', summary.pin ? 'set' : c.dim('not set')]);

  // Config location
  rows.push(['Config', c.dim(CONFIG_PATH)]);

  // Print aligned
  const maxLabel = Math.max(...rows.map(r => r[0].length));
  for (const [label, value] of rows) {
    if (label) {
      console.log(`  ${label.padEnd(maxLabel + 2)}${value}`);
    } else {
      console.log(`  ${''.padEnd(maxLabel + 2)}${value}`);
    }
  }

  if (!config.owner_id) {
    console.log(`\n  Pairing code: ${c.bold(config.pairing_code)}`);
    console.log('  Send /start <code> to your bot to pair as owner.');
  }

  console.log(`\nRun ${c.bold('multis')} to launch.`);

  rl.close();
}

/**
 * Verify LLM connectivity with a minimal API call.
 * Uses the raw provider to send a tiny request.
 */
async function verifyLLM(llmConfig) {
  const { createProvider, simpleGenerate } = require('../src/llm/provider-adapter');
  const provider = createProvider(llmConfig);
  const client = simpleGenerate(provider);
  await client.generate('Say "ok".', { maxTokens: 8 });
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
function runStart() {
  // Check not already running
  if (isRunning()) {
    const pid = fs.readFileSync(PID_PATH, 'utf-8').trim();
    console.log(`multis is already running (PID ${pid}).`);
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('No config found. Run: multis init\n  or: multis → 1) init');
    process.exit(1);
  }

  const logPath = PATHS.daemonLog();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn('node', [SRC_INDEX], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env }
  });

  fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
  fs.writeFileSync(PID_PATH, String(child.pid));
  child.unref();
  console.log(`multis started (PID ${child.pid}).`);
  console.log(`Log: ${logPath}`);
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------
function runStop() {
  if (!fs.existsSync(PID_PATH)) {
    console.log('multis is not running (no PID file).');
    process.exit(0);
  }

  const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to PID ${pid}.`);
  } catch (err) {
    if (err.code === 'ESRCH') {
      console.log(`Process ${pid} not found (stale PID file). Cleaning up.`);
    } else {
      console.error(`Error stopping: ${err.message}`);
    }
  }

  // Clean up PID file
  try { fs.unlinkSync(PID_PATH); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------
function runRestart() {
  if (isRunning()) {
    const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped PID ${pid}.`);
    } catch (err) {
      if (err.code !== 'ESRCH') {
        console.error(`Error stopping: ${err.message}`);
      }
    }
    try { fs.unlinkSync(PID_PATH); } catch { /* ignore */ }
    // Brief pause to let the process exit and release the Telegram polling connection
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    wait(1000).then(() => runStart());
    return;
  }
  // Not running — just start
  runStart();
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
function runStatus() {
  if (isRunning()) {
    const pid = fs.readFileSync(PID_PATH, 'utf-8').trim();
    console.log(`multis is running (PID ${pid}).`);
  } else {
    console.log('multis is not running.');
    // Clean stale PID
    if (fs.existsSync(PID_PATH)) {
      try { fs.unlinkSync(PID_PATH); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
async function runDoctor() {
  const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
  const green  = (s) => `\x1b[32m${s}\x1b[0m`;
  const red    = (s) => `\x1b[31m${s}\x1b[0m`;
  const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
  const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
  const ok     = green('✓');
  const fail   = red('✗');

  // Load config
  let config = null;
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { /* */ }

  console.log(bold('\nmultis doctor\n'));

  // ── Profile ──────────────────────────────────────
  console.log(dim('── Profile ') + dim('─'.repeat(42)));

  const profileRows = [];

  // Version
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  profileRows.push(['Version', pkg.version]);

  // Status (running/stopped)
  if (isRunning()) {
    const pid = fs.readFileSync(PID_PATH, 'utf-8').trim();
    profileRows.push(['Status', green('running') + dim(` (PID ${pid})`)]);
  } else {
    profileRows.push(['Status', yellow('stopped')]);
  }

  // Mode
  profileRows.push(['Mode', config?.bot_mode || yellow('not set')]);

  // Telegram
  if (config?.platforms?.telegram?.enabled) {
    const botName = config.platforms.telegram.bot_username;
    const owner = config.owner_id;
    let tgVal = botName ? `@${botName}` : dim('token set');
    if (owner) tgVal += dim(` (owner: ${owner})`);
    profileRows.push(['Telegram', tgVal]);
  } else {
    profileRows.push(['Telegram', dim('disabled')]);
  }

  // Beeper — detect networks from chat_modes or _pendingMode
  if (config?.platforms?.beeper?.enabled) {
    const url = config.platforms.beeper.url || 'localhost:23373';
    const host = url.replace(/^https?:\/\//, '');
    // Detect networks from _pendingMode matches
    const networks = new Set();
    if (config._pendingMode) {
      for (const pending of Object.values(config._pendingMode)) {
        for (const m of (pending.matches || [])) {
          if (m.network) networks.add(m.network);
        }
      }
    }
    const netStr = networks.size > 0 ? ` (${[...networks].join(', ')})` : '';
    let beeperReachable = false;
    try {
      const fullUrl = url.startsWith('http') ? url : `http://${url}`;
      await fetch(`${fullUrl}/v1/spec`, { signal: AbortSignal.timeout(2000) });
      beeperReachable = true;
    } catch { /* Desktop not reachable */ }
    const beeperStatus = beeperReachable ? ok : fail;
    profileRows.push(['Beeper', `${host}${netStr} ${beeperStatus}`]);
  } else {
    profileRows.push(['Beeper', dim('disabled')]);
  }

  // LLM — verify connectivity
  let llmVerified = false;
  const provider = config?.llm?.provider;
  const hasKey = config?.llm?.apiKey || provider === 'ollama';
  if (provider && hasKey) {
    const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
    const model = config.llm.model || 'default';
    try {
      await verifyLLM(config.llm);
      llmVerified = true;
      profileRows.push(['LLM', `${providerName} (${model}) ${ok}`]);
    } catch (err) {
      profileRows.push(['LLM', `${providerName} (${model}) ${fail} ${dim(err.message)}`]);
    }
  } else {
    profileRows.push(['LLM', provider ? yellow(`${provider} (no API key)`) : yellow('not configured')]);
  }

  // Agents
  if (config?.agents && typeof config.agents === 'object' && !Array.isArray(config.agents)) {
    const names = Object.keys(config.agents);
    profileRows.push(['Agents', names.join(', ') || dim('none')]);
  } else {
    profileRows.push(['Agents', dim('single-agent mode')]);
  }

  // PIN
  profileRows.push(['PIN', config?.security?.pin_hash ? 'enabled' : dim('not set')]);

  // Print profile rows aligned
  const maxProfileLabel = Math.max(...profileRows.map(r => r[0].length));
  for (const [label, value] of profileRows) {
    console.log(`  ${label.padEnd(maxProfileLabel + 2)}${value}`);
  }

  // ── Health ──────────────────────────────────────
  console.log('\n' + dim('── Health ') + dim('─'.repeat(43)));

  const checks = [];

  function check(name, fn) {
    try {
      const result = fn();
      checks.push({ name, ok: result.ok, detail: result.detail, warnings: result.warnings });
    } catch (err) {
      checks.push({ name, ok: false, detail: err.message });
    }
  }

  // Node.js
  check('Node.js', () => {
    const major = parseInt(process.versions.node.split('.')[0], 10);
    return { ok: major >= 20, detail: `v${process.versions.node}` };
  });

  // Config
  check('Config', () => {
    if (!fs.existsSync(CONFIG_PATH)) return { ok: false, detail: 'not found — run multis init' };
    if (!config) return { ok: false, detail: 'invalid JSON' };
    if (!config.owner_id) return { ok: false, detail: 'no owner — run multis init' };
    return { ok: true, detail: `owner: ${config.owner_id}, ${config.allowed_users?.length || 0} user(s)` };
  });

  // Database
  check('Database', () => {
    const dbPath = PATHS.db();
    if (!fs.existsSync(dbPath)) return { ok: true, detail: 'not created yet' };
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const total = db.prepare('SELECT COUNT(*) as c FROM chunks').get();
      const byType = db.prepare('SELECT element_type, COUNT(*) as c FROM chunks GROUP BY element_type').all();
      db.close();
      const typeStr = byType.map(r => `${r.element_type}: ${r.c}`).join(', ');
      return { ok: true, detail: `${total.c} chunks (${typeStr || 'empty'})` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  });

  // Memory
  check('Memory', () => {
    const memDir = PATHS.memory();
    if (!fs.existsSync(memDir)) return { ok: true, detail: 'not created yet' };
    const dirs = fs.readdirSync(memDir, { withFileTypes: true }).filter(d => d.isDirectory());
    return { ok: true, detail: `${dirs.length} chat(s)` };
  });

  // Agents config validation
  if (config?.agents && typeof config.agents === 'object' && !Array.isArray(config.agents)) {
    check('Agents', () => {
      const warnings = [];
      const agentNames = [];

      for (const [name, agent] of Object.entries(config.agents)) {
        if (!agent || typeof agent !== 'object') { warnings.push(`"${name}" invalid`); continue; }
        if (!agent.persona) { warnings.push(`"${name}" missing persona`); continue; }
        agentNames.push(name);
      }

      if (config.defaults && typeof config.defaults === 'object') {
        const validModes = ['off', 'business', 'silent', 'personal'];
        for (const [mode, agentName] of Object.entries(config.defaults)) {
          if (!validModes.includes(mode)) {
            warnings.push(`default "${mode}" is not a valid mode`);
          } else if (!agentNames.includes(agentName)) {
            warnings.push(`default "${mode}" points to unknown agent "${agentName}"`);
          }
        }
      }

      if (config.chat_agents && typeof config.chat_agents === 'object') {
        for (const [chatId, agentName] of Object.entries(config.chat_agents)) {
          if (!agentNames.includes(agentName)) {
            warnings.push(`chat_agents["${chatId}"] → unknown agent "${agentName}"`);
          }
        }
      }

      return { ok: warnings.length === 0, detail: `${agentNames.length} validated`, warnings };
    });
  }

  // Governance
  check('Governance', () => {
    const govPath = PATHS.governance();
    if (!fs.existsSync(govPath)) return { ok: false, detail: 'governance.json not found' };
    const gov = JSON.parse(fs.readFileSync(govPath, 'utf-8'));
    return { ok: true, detail: `allowlist: ${gov.allowlist?.length || 0}, denylist: ${gov.denylist?.length || 0}` };
  });

  // Tools
  check('Tools', () => {
    const toolsPath = PATHS.tools();
    if (!fs.existsSync(toolsPath)) return { ok: true, detail: 'defaults' };
    try {
      const tools = JSON.parse(fs.readFileSync(toolsPath, 'utf-8'));
      const entries = Object.entries(tools.tools || {});
      const enabled = entries.filter(([, v]) => v.enabled !== false).length;
      return { ok: true, detail: `${enabled}/${entries.length} enabled` };
    } catch (err) {
      return { ok: false, detail: `parse error: ${err.message}` };
    }
  });

  // Audit log
  check('Audit log', () => {
    const auditPath = PATHS.auditLog();
    return { ok: true, detail: fs.existsSync(auditPath) ? 'exists' : 'not yet created' };
  });

  // Beeper API (async check — can't use sync check() helper)
  if (config?.platforms?.beeper?.enabled) {
    const url = config.platforms.beeper.url || 'http://localhost:23373';
    const fullUrl = url.startsWith('http') ? url : `http://${url}`;
    let beeperOk = false;
    try {
      await fetch(`${fullUrl}/v1/spec`, { signal: AbortSignal.timeout(2000) });
      beeperOk = true;
    } catch { /* Desktop not reachable */ }
    checks.push({
      name: 'Beeper API',
      ok: beeperOk,
      detail: beeperOk ? 'Desktop reachable' : 'Desktop not reachable — start Beeper Desktop'
    });
  }

  // Print passing checks
  const passing = checks.filter(c => c.ok);
  const failing = checks.filter(c => !c.ok);
  const maxCheckLabel = Math.max(...checks.map(c => c.name.length));

  for (const c of passing) {
    console.log(`  ${ok}  ${c.name.padEnd(maxCheckLabel + 2)}${dim(c.detail)}`);
  }

  // ── Issues ──────────────────────────────────────
  // Collect all issues: failed checks + warnings from passing checks
  const issues = [];
  for (const c of failing) {
    issues.push({ name: c.name, detail: c.detail });
  }
  for (const c of checks) {
    if (c.warnings) {
      for (const w of c.warnings) {
        issues.push({ name: c.name, detail: w });
      }
    }
  }

  // LLM failure is already shown in profile, but add to issues if not verified
  if (provider && hasKey && !llmVerified) {
    issues.push({ name: 'LLM', detail: 'verification failed (see profile above)' });
  }

  if (issues.length > 0) {
    console.log('\n' + dim('── Issues ') + dim('─'.repeat(43)));
    for (const issue of issues) {
      console.log(`  ${fail}  ${issue.name.padEnd(maxCheckLabel + 2)}${issue.detail}`);
    }
  }

  // Summary
  const totalChecks = checks.length + (provider && hasKey ? 1 : 0); // include LLM
  const totalPassing = passing.length + (llmVerified ? 1 : 0);
  console.log(`\n${totalPassing}/${totalChecks} checks passed.`);
  if (issues.length > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function isRunning() {
  if (!fs.existsSync(PID_PATH)) return false;
  const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
