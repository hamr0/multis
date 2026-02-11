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
async function runInit() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

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

  // Telegram token
  const currentToken = config.telegram_bot_token || '';
  const token = await ask(`Telegram bot token${currentToken ? ` [${currentToken.slice(0, 8)}...]` : ''}: `);
  if (token.trim()) {
    config.telegram_bot_token = token.trim();
    if (!config.platforms) config.platforms = {};
    if (!config.platforms.telegram) config.platforms.telegram = {};
    config.platforms.telegram.bot_token = token.trim();
    config.platforms.telegram.enabled = true;
  }

  // LLM provider
  const currentProvider = config.llm?.provider || 'anthropic';
  const provider = await ask(`LLM provider (anthropic/openai/ollama) [${currentProvider}]: `);
  if (!config.llm) config.llm = {};
  config.llm.provider = provider.trim() || currentProvider;

  // API key (skip for ollama)
  if (config.llm.provider !== 'ollama') {
    const currentKey = config.llm?.apiKey || '';
    const key = await ask(`API key${currentKey ? ' [configured]' : ''}: `);
    if (key.trim()) config.llm.apiKey = key.trim();
  }

  // PIN
  const pinChoice = await ask('Set a PIN for owner commands? (4-6 digits, or press Enter to skip): ');
  if (pinChoice.trim() && /^\d{4,6}$/.test(pinChoice.trim())) {
    if (!config.security) config.security = {};
    config.security.pin_hash = crypto.createHash('sha256').update(pinChoice.trim()).digest('hex');
    console.log('PIN set.');
  }

  // Beeper
  const beeperChoice = await ask('Enable Beeper Desktop API? (y/N): ');
  if (!config.platforms) config.platforms = {};
  if (!config.platforms.beeper) config.platforms.beeper = {};
  config.platforms.beeper.enabled = beeperChoice.trim().toLowerCase() === 'y';

  // Pairing code
  if (!config.pairing_code) {
    config.pairing_code = crypto.randomBytes(3).toString('hex').toUpperCase();
  }

  // Ensure allowed_users array
  if (!config.allowed_users) config.allowed_users = [];

  // Save
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  // Copy governance template if not present
  const govPath = path.join(MULTIS_DIR, 'governance.json');
  const govTemplate = path.join(__dirname, '..', '.multis-template', 'governance.json');
  if (!fs.existsSync(govPath) && fs.existsSync(govTemplate)) {
    fs.copyFileSync(govTemplate, govPath);
  }

  console.log(`\nConfig saved to ${CONFIG_PATH}`);
  console.log(`Pairing code: ${config.pairing_code}`);
  console.log('\nRun: multis start');

  rl.close();
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
  check('LLM provider', () => {
    const provider = config?.llm?.provider;
    const hasKey = config?.llm?.apiKey || provider === 'ollama';
    return { ok: !!provider && !!hasKey, detail: `${provider || 'none'}${hasKey ? '' : ' (no API key)'}` };
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
