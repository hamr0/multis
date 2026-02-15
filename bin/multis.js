#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const MULTIS_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.multis');
const PID_PATH = path.join(MULTIS_DIR, 'multis.pid');
const CONFIG_PATH = path.join(MULTIS_DIR, 'config.json');
const SRC_INDEX = path.join(__dirname, '..', 'src', 'index.js');

const command = process.argv[2];

switch (command) {
  case 'init':
    runInit();
    break;
  case 'start':
    runStart();
    break;
  case 'stop':
    runStop();
    break;
  case 'status':
    runStatus();
    break;
  case 'doctor':
    runDoctor();
    break;
  default:
    console.log('Usage: multis <init|start|stop|status|doctor>');
    console.log('');
    console.log('Commands:');
    console.log('  init    - Set up multis (interactive wizard)');
    console.log('  start   - Start daemon in background');
    console.log('  stop    - Stop running daemon');
    console.log('  status  - Check if daemon is running');
    console.log('  doctor  - Run diagnostic checks');
    process.exit(command ? 1 : 0);
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

  // Track what was set up for the summary
  const summary = { telegram: null, beeper: null, llm: null, pin: false };

  console.log('multis init — interactive setup\n');

  // Ensure directory
  if (!fs.existsSync(MULTIS_DIR)) {
    fs.mkdirSync(MULTIS_DIR, { recursive: true });
  }

  // Load existing or create fresh config
  let config = {};
  const templatePath = path.join(__dirname, '..', '.multis-template', 'config.json');
  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    console.log('Existing config found. Updating...\n');
  } else if (fs.existsSync(templatePath)) {
    config = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  }

  // -----------------------------------------------------------------------
  // Step 1: Platform selection
  // -----------------------------------------------------------------------
  console.log('Which platform will you use?');
  console.log('  1) Telegram  — chat via your own Telegram bot');
  console.log('  2) Beeper    — use Beeper Desktop (no API keys needed)');
  console.log('  3) Both');
  const platformChoice = (await ask('\nChoose (1/2/3) [1]: ')).trim() || '1';

  const useTelegram = platformChoice === '1' || platformChoice === '3';
  const useBeeper = platformChoice === '2' || platformChoice === '3';

  if (!config.platforms) config.platforms = {};

  // -----------------------------------------------------------------------
  // Step 1b: Bot mode (personal or business)
  // -----------------------------------------------------------------------
  console.log('\nHow will you use this bot?');
  console.log('  1) Personal  — your private assistant, all chats silent by default');
  console.log('  2) Business  — customer support, all chats auto-respond by default');
  const modeChoice = (await ask('\nChoose (1/2) [1]: ')).trim() || '1';
  config.bot_mode = modeChoice === '2' ? 'business' : 'personal';
  summary.botMode = config.bot_mode;

  // -----------------------------------------------------------------------
  // Step 2a: Telegram setup
  // -----------------------------------------------------------------------
  if (useTelegram) {
    console.log('\n--- Telegram Setup ---\n');
    console.log('To use Telegram, you need to create a bot:');
    console.log('  1. Open Telegram and search for @BotFather');
    console.log('  2. Send /newbot');
    console.log('  3. Pick a display name (e.g. "My Assistant")');
    console.log('  4. Pick a username ending in "bot" (e.g. "my_assistant_bot")');
    console.log('  5. BotFather will reply with a token — copy it\n');

    let token = '';
    let botUsername = '';
    while (!botUsername) {
      const currentToken = config.telegram_bot_token || config.platforms?.telegram?.bot_token || '';
      token = (await ask(`Paste your bot token${currentToken ? ` [${currentToken.slice(0, 8)}...]` : ''}: `)).trim();
      if (!token && currentToken) token = currentToken;

      if (!token) {
        console.log('  Token required for Telegram. Try again.\n');
        continue;
      }

      // Validate format
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        console.log('  Invalid token format (expected digits:alphanumeric). Try again.\n');
        continue;
      }

      // Verify with Telegram API
      console.log('  Verifying token...');
      try {
        const { Telegraf } = require('telegraf');
        const testBot = new Telegraf(token);
        const me = await testBot.telegram.getMe();
        botUsername = me.username;
        console.log(`  Token verified — bot is @${botUsername}\n`);

        // Try inline pairing: wait for /start
        console.log(`  Now open Telegram and send /start to @${botUsername}`);
        console.log('  Waiting up to 60 seconds...\n');

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
          console.log(`  Paired as owner! (@${paired.username})\n`);
          summary.telegram = `connected (@${botUsername}), paired as owner`;
        } else {
          console.log('  No /start received within 60s. You can pair later via /start <code>.\n');
          summary.telegram = `connected (@${botUsername}), not yet paired`;
        }
      } catch (err) {
        console.log(`  Token verification failed: ${err.message}`);
        const retry = (await ask('  Try a different token? (Y/n): ')).trim().toLowerCase();
        if (retry === 'n') {
          summary.telegram = 'token not verified';
          break;
        }
        continue;
      }
    }

    // Save Telegram config
    config.telegram_bot_token = token;
    if (!config.platforms.telegram) config.platforms.telegram = {};
    config.platforms.telegram.bot_token = token;
    config.platforms.telegram.enabled = true;
  } else {
    if (!config.platforms.telegram) config.platforms.telegram = {};
    config.platforms.telegram.enabled = false;
  }

  // -----------------------------------------------------------------------
  // Step 2b: Beeper setup
  // -----------------------------------------------------------------------
  if (useBeeper) {
    console.log('\n--- Beeper Setup ---\n');
    try {
      const beeper = require('../src/cli/setup-beeper');

      // Check Desktop API
      console.log('Checking Beeper Desktop API...');
      let reachable = await beeper.checkDesktop();

      if (!reachable) {
        console.log('  Not reachable at localhost:23373');
        console.log('  Make sure Beeper Desktop is open and the API is enabled:');
        console.log('    Settings > Developers > toggle on\n');
        await ask('Press Enter to retry...');
        reachable = await beeper.checkDesktop();
      }

      if (reachable) {
        console.log('  Desktop API is reachable.\n');

        // OAuth
        console.log('Authenticating...');
        let token = null;
        const saved = beeper.loadToken();
        if (saved?.access_token) {
          try {
            await beeper.api(saved.access_token, 'GET', '/v1/accounts');
            token = saved.access_token;
            console.log('  Using existing token.');
          } catch {
            console.log('  Saved token expired, re-authenticating...');
          }
        }

        if (!token) {
          console.log('  Starting OAuth PKCE flow...');
          token = await beeper.oauthPKCE();
          console.log('  Authenticated!');
        }

        // List accounts
        console.log('\nConnected accounts:');
        const accounts = await beeper.api(token, 'GET', '/v1/accounts');
        const list = Array.isArray(accounts) ? accounts : accounts.items || [];
        for (const acc of list) {
          const name = acc.user?.displayText || acc.user?.id || acc.accountID || '?';
          console.log(`  - ${acc.network || '?'}: ${name}`);
        }

        // Apply beeper settings to in-memory config (saved later in step 5)
        if (!config.platforms) config.platforms = {};
        if (!config.platforms.beeper) config.platforms.beeper = {};
        config.platforms.beeper.enabled = true;
        config.platforms.beeper.url = config.platforms.beeper.url || 'http://localhost:23373';
        config.platforms.beeper.command_prefix = config.platforms.beeper.command_prefix || '//';
        config.platforms.beeper.poll_interval = config.platforms.beeper.poll_interval || 3000;

        // Warnings
        console.log('\nImportant:');
        console.log('  - Beeper Desktop must be running for multis to work');
        console.log('  - Save your recovery key: Settings > Security > Recovery Key');
        console.log('  - Unlike Telegram, multis stops when Beeper Desktop is closed\n');

        summary.beeper = `connected (${list.length} account${list.length !== 1 ? 's' : ''})`;
      } else {
        console.log('  Still not reachable. Skipping Beeper for now.\n');
        summary.beeper = 'not reachable (skipped)';
      }
    } catch (err) {
      console.log(`  Beeper setup error: ${err.message}\n`);
      summary.beeper = `error: ${err.message}`;
    }
  } else {
    if (!config.platforms.beeper) config.platforms.beeper = {};
    config.platforms.beeper.enabled = false;
  }

  // -----------------------------------------------------------------------
  // Step 3: LLM provider
  // -----------------------------------------------------------------------
  console.log('--- LLM Setup ---\n');
  console.log('Which LLM provider?');
  console.log('  1) Anthropic (Claude)');
  console.log('  2) OpenAI (GPT)');
  console.log('  3) OpenAI-compatible (OpenRouter, Together, Groq, GLM, etc.)');
  console.log('  4) Ollama (local, free, no API key)');
  const llmChoice = (await ask('\nChoose (1/2/3/4) [1]: ')).trim() || '1';

  if (!config.llm) config.llm = {};

  switch (llmChoice) {
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
        else if (!currentKey) { console.log('  API key required.\n'); continue; }

        console.log('  Verifying...');
        try {
          await verifyLLM(config.llm);
          console.log('  Verified!\n');
          verified = true;
        } catch (err) {
          console.log(`  Verification failed: ${err.message}`);
          const retry = (await ask('  Try again? (Y/n): ')).trim().toLowerCase();
          if (retry === 'n') break;
        }
      }
      summary.llm = `Anthropic (${config.llm.model})${verified ? ' — verified' : ''}`;
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
        else if (!currentKey) { console.log('  API key required.\n'); continue; }

        console.log('  Verifying...');
        try {
          await verifyLLM(config.llm);
          console.log('  Verified!\n');
          verified = true;
        } catch (err) {
          console.log(`  Verification failed: ${err.message}`);
          const retry = (await ask('  Try again? (Y/n): ')).trim().toLowerCase();
          if (retry === 'n') break;
        }
      }
      summary.llm = `OpenAI (${config.llm.model})${verified ? ' — verified' : ''}`;
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
        else { console.log('  API key required.\n'); continue; }

        console.log('  Verifying...');
        try {
          await verifyLLM(config.llm);
          console.log('  Verified!\n');
          verified = true;
        } catch (err) {
          console.log(`  Verification failed: ${err.message}`);
          const retry = (await ask('  Try again? (Y/n): ')).trim().toLowerCase();
          if (retry === 'n') break;
        }
      }

      // Extract display name from baseUrl
      let displayName = 'OpenAI-compatible';
      try { displayName = new URL(baseUrl).hostname.replace('www.', ''); } catch { /* */ }
      summary.llm = `${displayName} (${config.llm.model})${verified ? ' — verified' : ''}`;
      break;
    }

    case '4': { // Ollama
      const defaults = LLM_DEFAULTS.ollama;
      config.llm.provider = defaults.provider;
      config.llm.model = defaults.model;
      config.llm.baseUrl = defaults.baseUrl;
      config.llm.apiKey = '';

      console.log('  Checking Ollama at localhost:11434...');
      try {
        await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        console.log('  Ollama is running!\n');
        summary.llm = `Ollama (${config.llm.model}) — verified`;
      } catch {
        console.log('  Ollama not reachable. Install from https://ollama.com');
        console.log('  Config saved — start Ollama before running multis.\n');
        summary.llm = `Ollama (${config.llm.model}) — not running`;
      }
      break;
    }

    default:
      console.log('  Invalid choice, defaulting to Anthropic.\n');
      config.llm.provider = 'anthropic';
      config.llm.model = LLM_DEFAULTS.anthropic.model;
      summary.llm = 'Anthropic (default)';
  }

  // -----------------------------------------------------------------------
  // Step 4: PIN
  // -----------------------------------------------------------------------
  console.log('--- Security ---\n');
  const pinChoice = (await ask('Set a PIN for sensitive commands like /exec? (4-6 digits, Enter to skip): ')).trim();
  if (pinChoice && /^\d{4,6}$/.test(pinChoice)) {
    if (!config.security) config.security = {};
    config.security.pin_hash = crypto.createHash('sha256').update(pinChoice).digest('hex');
    console.log('  PIN set.\n');
    summary.pin = true;
  } else if (pinChoice) {
    console.log('  Invalid PIN (must be 4-6 digits). Skipping.\n');
  }

  // -----------------------------------------------------------------------
  // Step 5: Save + Summary
  // -----------------------------------------------------------------------

  // Ensure pairing code
  if (!config.pairing_code) {
    config.pairing_code = crypto.randomBytes(3).toString('hex').toUpperCase();
  }
  if (!config.allowed_users) config.allowed_users = [];

  // Save
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  // Copy governance template if not present
  const govPath = path.join(MULTIS_DIR, 'governance.json');
  const govTemplate = path.join(__dirname, '..', '.multis-template', 'governance.json');
  if (!fs.existsSync(govPath) && fs.existsSync(govTemplate)) {
    fs.copyFileSync(govTemplate, govPath);
  }

  console.log(`Config saved to ${CONFIG_PATH}\n`);
  console.log(`  Mode:      ${summary.botMode}`);
  if (summary.telegram) console.log(`  Telegram:  ${summary.telegram}`);
  if (summary.beeper) console.log(`  Beeper:    ${summary.beeper}`);
  if (summary.llm) console.log(`  LLM:       ${summary.llm}`);
  console.log(`  PIN:       ${summary.pin ? 'set' : 'not set'}`);

  if (!config.owner_id) {
    console.log(`\n  Pairing code: ${config.pairing_code}`);
    console.log('  Send /start <code> to your bot to pair as owner.');
  }

  console.log('\nRun: multis start');

  rl.close();
}

/**
 * Verify LLM connectivity with a minimal API call.
 * Uses the raw provider to send a tiny request.
 */
async function verifyLLM(llmConfig) {
  const { createLLMClient } = require('../src/llm/client');
  const client = createLLMClient(llmConfig);
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
    console.log('No config found. Run: multis init');
    process.exit(1);
  }

  const logPath = path.join(MULTIS_DIR, 'daemon.log');
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn('node', [SRC_INDEX], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env }
  });

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
  const checks = [];

  function check(name, fn) {
    try {
      const result = fn();
      checks.push({ name, ok: result.ok, detail: result.detail });
    } catch (err) {
      checks.push({ name, ok: false, detail: err.message });
    }
  }

  // Node.js version
  check('Node.js >= 20', () => {
    const major = parseInt(process.versions.node.split('.')[0], 10);
    return { ok: major >= 20, detail: `v${process.versions.node}` };
  });

  // ~/.multis exists
  check('~/.multis directory', () => {
    return { ok: fs.existsSync(MULTIS_DIR), detail: MULTIS_DIR };
  });

  // config.json valid
  check('config.json valid', () => {
    if (!fs.existsSync(CONFIG_PATH)) return { ok: false, detail: 'not found' };
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return { ok: true, detail: `owner: ${config.owner_id || 'none'}` };
  });

  // Owner + paired users
  let config = null;
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch { /* */ }

  check('Owner configured', () => {
    return { ok: !!config?.owner_id, detail: config?.owner_id ? `ID: ${config.owner_id}` : 'not set' };
  });

  check('Paired users', () => {
    const count = config?.allowed_users?.length || 0;
    return { ok: count > 0, detail: `${count} user(s)` };
  });

  // Telegram
  check('Telegram bot token', () => {
    const token = config?.telegram_bot_token || config?.platforms?.telegram?.bot_token || process.env.TELEGRAM_BOT_TOKEN;
    return { ok: !!token, detail: token ? `${token.slice(0, 8)}...` : 'not set' };
  });

  // Beeper
  check('Beeper Desktop API', () => {
    const enabled = config?.platforms?.beeper?.enabled;
    if (!enabled) return { ok: true, detail: 'disabled (optional)' };
    // Quick reachability check
    try {
      const net = require('net');
      const url = config.platforms.beeper.url || 'http://localhost:23373';
      const port = parseInt(url.split(':').pop(), 10);
      return { ok: true, detail: `enabled, port ${port}` };
    } catch {
      return { ok: false, detail: 'enabled but unreachable' };
    }
  });

  // LLM
  // LLM check — async, verify actual connectivity
  {
    const provider = config?.llm?.provider;
    const hasKey = config?.llm?.apiKey || provider === 'ollama';
    if (!provider || !hasKey) {
      checks.push({ name: 'LLM provider', ok: false, detail: `${provider || 'none'}${hasKey ? '' : ' (no API key)'}` });
    } else {
      try {
        await verifyLLM(config.llm);
        checks.push({ name: 'LLM provider', ok: true, detail: `${provider} — verified` });
      } catch (err) {
        checks.push({ name: 'LLM provider', ok: false, detail: `${provider} — ${err.message}` });
      }
    }
  }

  // Agents
  check('Agents', () => {
    if (!config?.agents) return { ok: true, detail: 'not configured (single-agent mode)' };
    if (typeof config.agents !== 'object' || Array.isArray(config.agents)) {
      return { ok: false, detail: '"agents" must be an object' };
    }

    const warnings = [];
    const agentNames = [];

    for (const [name, agent] of Object.entries(config.agents)) {
      if (!agent || typeof agent !== 'object') {
        warnings.push(`"${name}" invalid`);
        continue;
      }
      if (!agent.persona) {
        warnings.push(`"${name}" missing persona`);
        continue;
      }
      if (agent.model && typeof agent.model !== 'string') {
        warnings.push(`"${name}" model must be a string`);
      }
      agentNames.push(name);
    }

    // Check defaults reference valid agents
    if (config.defaults && typeof config.defaults === 'object') {
      const validModes = ['personal', 'business'];
      for (const [mode, agentName] of Object.entries(config.defaults)) {
        if (!validModes.includes(mode)) {
          warnings.push(`default "${mode}" is not a valid mode`);
        } else if (!agentNames.includes(agentName)) {
          warnings.push(`default "${mode}" points to unknown agent "${agentName}"`);
        }
      }
    }

    // Check chat_agents reference valid agents
    if (config.chat_agents && typeof config.chat_agents === 'object') {
      for (const [chatId, agentName] of Object.entries(config.chat_agents)) {
        if (!agentNames.includes(agentName)) {
          warnings.push(`chat_agents["${chatId}"] points to unknown agent "${agentName}"`);
        }
      }
    }

    if (warnings.length > 0) {
      const detail = `${agentNames.length} defined (${agentNames.join(', ')})\n` +
        warnings.map(w => `           WARNING — ${w}`).join('\n');
      return { ok: false, detail };
    }

    const defaultsStr = config.defaults
      ? Object.entries(config.defaults).map(([m, a]) => `${m}→${a}`).join(', ')
      : 'none';
    return { ok: true, detail: `${agentNames.length} defined (${agentNames.join(', ')}) — defaults: ${defaultsStr}` };
  });

  // SQLite DB
  check('SQLite database', () => {
    const dbPath = path.join(MULTIS_DIR, 'documents.db');
    if (!fs.existsSync(dbPath)) return { ok: true, detail: 'not created yet (OK)' };
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const total = db.prepare('SELECT COUNT(*) as c FROM chunks').get();
      const byType = db.prepare('SELECT document_type, COUNT(*) as c FROM chunks GROUP BY document_type').all();
      db.close();
      const typeStr = byType.map(r => `${r.document_type}: ${r.c}`).join(', ');
      return { ok: true, detail: `${total.c} chunks (${typeStr || 'empty'})` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  });

  // Audit log
  check('Audit log', () => {
    const auditPath = path.join(MULTIS_DIR, 'audit.log');
    return { ok: true, detail: fs.existsSync(auditPath) ? 'exists' : 'will be created on first event' };
  });

  // Memory directories
  check('Memory directories', () => {
    const memDir = path.join(MULTIS_DIR, 'memory', 'chats');
    if (!fs.existsSync(memDir)) return { ok: true, detail: 'not created yet (OK)' };
    const dirs = fs.readdirSync(memDir, { withFileTypes: true }).filter(d => d.isDirectory());
    return { ok: true, detail: `${dirs.length} chat(s)` };
  });

  // PIN
  check('PIN authentication', () => {
    const pinSet = !!config?.security?.pin_hash;
    return {
      ok: true,
      detail: pinSet ? 'enabled (recovery: remove pin_hash from config.json)' : 'not set (optional)'
    };
  });

  // Governance
  check('Governance config', () => {
    const govPath = path.join(MULTIS_DIR, 'governance.json');
    if (!fs.existsSync(govPath)) return { ok: false, detail: 'governance.json not found' };
    const gov = JSON.parse(fs.readFileSync(govPath, 'utf-8'));
    return { ok: true, detail: `allowlist: ${gov.allowlist?.length || 0}, denylist: ${gov.denylist?.length || 0}` };
  });

  // Print results
  console.log('\nmultis doctor\n');
  let failures = 0;
  for (const c of checks) {
    const icon = c.ok ? '[OK]' : '[FAIL]';
    console.log(`  ${icon}  ${c.name} — ${c.detail}`);
    if (!c.ok) failures++;
  }
  console.log(`\n${checks.length - failures}/${checks.length} checks passed.`);
  if (failures > 0) process.exit(1);
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
