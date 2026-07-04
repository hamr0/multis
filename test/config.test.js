const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('loadConfig — default merging', () => {
  let tmpDir;
  let origHome;
  let origEnv;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-config-test-'));
    origHome = process.env.HOME;
    origEnv = { ...process.env };
    process.env.HOME = tmpDir;

    // Create .multis dir and template
    const multisDir = path.join(tmpDir, '.multis');
    fs.mkdirSync(multisDir, { recursive: true });

    // Create a minimal config.json
    const config = {
      telegram_bot_token: 'test-token',
      pairing_code: 'ABC123',
      allowed_users: [12345],
      owner_id: 12345,
      llm: { provider: 'anthropic', model: 'claude-3-haiku', apiKey: 'test-key' }
    };
    fs.writeFileSync(path.join(multisDir, 'config.json'), JSON.stringify(config, null, 2));

    // Create subdirs and governance.json so ensureMultisDir does not try to copy from template
    fs.mkdirSync(path.join(multisDir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(multisDir, 'auth', 'governance.json'), JSON.stringify({ allowlist: [], denylist: [] }));
  });

  after(() => {
    process.env.HOME = origHome;
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(origEnv)) {
      process.env[key] = val;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Force fresh require each time
    delete require.cache[require.resolve('../src/config')];
  });

  it('merges security defaults', () => {
    const { loadConfig } = require('../src/config');
    const config = loadConfig();

    assert.strictEqual(config.security.pin_timeout_hours, 24);
    assert.strictEqual(config.security.pin_lockout_minutes, 60);
    assert.strictEqual(config.security.prompt_injection_detection, true);
    // Secure default (M11): fail-closed on an unpriced LLM round is ON unless
    // explicitly disabled. Guards the default itself — the governance tests set
    // the flag explicitly, so only this asserts a silent flip to false.
    assert.strictEqual(config.security.fail_closed_on_unpriced, true);
  });

  it('fills security.rate_limit, llm.max_tool_rounds and documents bounds for pre-existing configs', () => {
    // The minimal config.json on disk has none of these — loadConfig must add
    // them so installs created before these knobs existed are still bounded.
    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const config = loadConfig();

    // #8 — agent loop is bounded
    assert.strictEqual(config.llm.max_tool_rounds, 5);
    // #1 — rate limit defaults present
    assert.strictEqual(config.security.rate_limit.enabled, true);
    assert.strictEqual(config.security.rate_limit.burst_per_min, 10);
    assert.strictEqual(config.security.rate_limit.daily_per_sender, 100);
    // #4 — parser bounds present
    assert.strictEqual(config.documents.maxSize, 10485760);
    assert.strictEqual(config.documents.maxPdfPages, 2000);
    assert.strictEqual(config.documents.parseTimeoutMs, 30000);
  });

  it('preserves a custom max_tool_rounds over the default', () => {
    const multisDir = path.join(tmpDir, '.multis');
    const config = JSON.parse(fs.readFileSync(path.join(multisDir, 'config.json'), 'utf-8'));
    config.llm = { ...config.llm, max_tool_rounds: 2 };
    fs.writeFileSync(path.join(multisDir, 'config.json'), JSON.stringify(config, null, 2));

    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    assert.strictEqual(loadConfig().llm.max_tool_rounds, 2, 'custom value must win');
  });

  it('preserves existing security values over defaults', () => {
    // Write config with custom security
    const multisDir = path.join(tmpDir, '.multis');
    const config = JSON.parse(fs.readFileSync(path.join(multisDir, 'config.json'), 'utf-8'));
    config.security = { pin_timeout_hours: 8, pin_hash: 'abc' };
    fs.writeFileSync(path.join(multisDir, 'config.json'), JSON.stringify(config, null, 2));

    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const loaded = loadConfig();

    assert.strictEqual(loaded.security.pin_timeout_hours, 8, 'should keep custom timeout');
    assert.strictEqual(loaded.security.pin_hash, 'abc', 'should keep pin_hash');
    assert.strictEqual(loaded.security.pin_lockout_minutes, 60, 'should fill in missing default');
  });

  it('merges business defaults', () => {
    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const config = loadConfig();

    assert.strictEqual(config.business.name, null);
    assert.ok(Array.isArray(config.business.topics));
    assert.ok(Array.isArray(config.business.rules));
    assert.ok(Array.isArray(config.business.allowed_urls));
    assert.ok(Array.isArray(config.business.escalation.escalate_keywords));
    assert.ok(config.business.escalation.escalate_keywords.includes('refund'));
  });

  it('merges memory defaults', () => {
    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const config = loadConfig();

    assert.strictEqual(config.memory.enabled, true);
    assert.strictEqual(config.memory.recent_window, 20);
    assert.strictEqual(config.memory.promote_threshold, 10);
    assert.strictEqual(config.memory.episode_window_days, 90); // litectx 0.25.0 episode retention+promotion window
    assert.strictEqual(config.memory.log_retention_days, 30);
    assert.strictEqual(config.memory.semantic, true);
    // W4 supersession knobs (no retention_days/admin_retention_days — episodes have no per-row TTL)
    assert.strictEqual(config.memory.supersede, true);
    assert.strictEqual(config.memory.supersede_candidates, 5);
    assert.strictEqual(config.memory.context_budget, 24000); // M5 conversation budget-fit
  });

  it('preserves custom memory values', () => {
    const multisDir = path.join(tmpDir, '.multis');
    const config = JSON.parse(fs.readFileSync(path.join(multisDir, 'config.json'), 'utf-8'));
    config.memory = { promote_threshold: 25, enabled: false };
    fs.writeFileSync(path.join(multisDir, 'config.json'), JSON.stringify(config, null, 2));

    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const loaded = loadConfig();

    assert.strictEqual(loaded.memory.promote_threshold, 25, 'a custom value overrides the default');
    assert.strictEqual(loaded.memory.enabled, false);
    assert.strictEqual(loaded.memory.log_retention_days, 30, 'should fill in missing defaults');
  });

  it('ensures platforms block exists', () => {
    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const config = loadConfig();

    assert.ok(config.platforms);
    assert.ok(config.platforms.telegram);
    assert.ok(config.platforms.beeper !== undefined);
  });

  it('syncs telegram_bot_token into platforms block', () => {
    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const config = loadConfig();

    assert.strictEqual(config.platforms.telegram.bot_token, config.telegram_bot_token);
  });

  it('isOwner returns true for owner_id', () => {
    delete require.cache[require.resolve('../src/config')];
    const { loadConfig, isOwner } = require('../src/config');
    const config = loadConfig();

    assert.strictEqual(isOwner(12345, config), true);
    assert.strictEqual(isOwner(99999, config), false);
  });

  it('generatePairingCode returns 6 uppercase hex chars', () => {
    delete require.cache[require.resolve('../src/config')];
    const { generatePairingCode } = require('../src/config');
    const code = generatePairingCode();
    assert.match(code, /^[0-9A-F]{6}$/);
  });
});

// ---------------------------------------------------------------------------
// Role ↔ default mode (PRD §3g). The owner's role sets how non-owner chats are
// treated by default. The legacy 2-value `personal` MUST stay an alias for
// personal-assistant so existing configs keep their behavior (no migration).
// ---------------------------------------------------------------------------
describe('role ↔ mode (§3g)', () => {
  const { defaultModeForRole, roleLabel, normalizeRole } = require('../src/config');

  it('maps the three roles to their non-owner default mode', () => {
    assert.equal(defaultModeForRole('business'), 'business');
    assert.equal(defaultModeForRole('personal-assistant'), 'silent');
    assert.equal(defaultModeForRole('personal-bot'), 'off');
  });

  it('treats legacy "personal" as personal-assistant (silent) — back-compat', () => {
    assert.equal(defaultModeForRole('personal'), 'silent');
    assert.equal(normalizeRole('personal'), 'personal-assistant');
  });

  it('defaults an unset/unknown role to personal-assistant (silent), never auto-respond', () => {
    assert.equal(defaultModeForRole(undefined), 'silent');
    assert.equal(defaultModeForRole('garbage'), 'silent');
  });

  it('gives a human label per role', () => {
    assert.equal(roleLabel('business'), 'Business chatbot');
    assert.equal(roleLabel('personal-assistant'), 'Personal assistant');
    assert.equal(roleLabel('personal-bot'), 'Personal bot');
    assert.equal(roleLabel('personal'), 'Personal assistant'); // legacy
  });
});

// The init wizard binds role ⟺ transport 1:1 (PRD §3g): personal-bot = Telegram,
// personal-assistant / business = Beeper. These functions ARE the wizard's Step-1
// logic (bin/multis.js routes through applyRoleTransport), so a regression in the
// binding — or in the role-switch flip — fails here.
describe('role ⟺ transport binding (§3g, init Step 1)', () => {
  const { transportForRole, applyRoleTransport, ROLE_BY_CHOICE } = require('../src/config');

  it('binds personal-bot to Telegram, the other roles to Beeper', () => {
    assert.deepEqual(transportForRole('personal-bot'), { useTelegram: true, useBeeper: false });
    assert.deepEqual(transportForRole('personal-assistant'), { useTelegram: false, useBeeper: true });
    assert.deepEqual(transportForRole('business'), { useTelegram: false, useBeeper: true });
  });

  it('canonicalizes legacy/unknown roles before binding (never Telegram by accident)', () => {
    assert.deepEqual(transportForRole('personal'), { useTelegram: false, useBeeper: true }); // legacy → assistant → Beeper
    assert.deepEqual(transportForRole('garbage'), { useTelegram: false, useBeeper: true });  // unknown → assistant → Beeper
  });

  it('maps the init menu choices to the three roles', () => {
    assert.equal(ROLE_BY_CHOICE['1'], 'personal-bot');
    assert.equal(ROLE_BY_CHOICE['2'], 'personal-assistant');
    assert.equal(ROLE_BY_CHOICE['3'], 'business');
  });

  it('switching to personal-bot flips OFF Beeper, leaves Telegram for the connect step', () => {
    // Start from a Beeper-role config with Beeper live (the assistant→bot switch).
    const config = { bot_mode: 'personal-assistant', platforms: { beeper: { enabled: true }, telegram: { enabled: false } } };
    const binding = applyRoleTransport(config, 'personal-bot');

    assert.equal(config.bot_mode, 'personal-bot');
    assert.equal(config.platforms.beeper.enabled, false, 'old Beeper transport is disabled');
    assert.deepEqual(binding, { useTelegram: true, useBeeper: false });
    // It must NOT pre-enable Telegram — that is the network-gated connect step's job.
    assert.notEqual(config.platforms.telegram.enabled, true, 'selected transport is left for the connect step');
  });

  it('switching to a Beeper role flips OFF Telegram', () => {
    const config = { bot_mode: 'personal-bot', platforms: { telegram: { enabled: true }, beeper: { enabled: false } } };
    const binding = applyRoleTransport(config, 'business');

    assert.equal(config.bot_mode, 'business');
    assert.equal(config.platforms.telegram.enabled, false, 'old Telegram transport is disabled');
    assert.deepEqual(binding, { useTelegram: false, useBeeper: true });
    assert.notEqual(config.platforms.beeper.enabled, true, 'selected transport is left for the connect step');
  });

  it('creates missing platform objects so the flip never throws on a bare config', () => {
    const config = {};
    applyRoleTransport(config, 'personal-bot');
    assert.equal(config.platforms.beeper.enabled, false);
    assert.equal(config.bot_mode, 'personal-bot');
  });
});

// init saves via saveConfig so the secret-bearing files land owner-only
// immediately (config.json holds the PIN hash + LLM API key + bot/MCP tokens).
describe('saveConfig — secret-file perms (init §10 S1)', () => {
  const { saveConfig, setMultisDir, PATHS } = require('../src/config');
  let parent, tmpDir;

  before(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-perms-test-'));
    // A subdir saveConfig CREATES itself — so it lands at the default 0755 and the
    // assertion below actually proves the chmod-to-0700 (not mkdtemp's own 0700).
    tmpDir = path.join(parent, 'multis-home');
    setMultisDir(tmpDir);
  });
  after(() => { setMultisDir(null); fs.rmSync(parent, { recursive: true, force: true }); });

  it('writes ~/.multis at 0700 and config.json at 0600', () => {
    saveConfig({ owner_id: '1', security: { pin_hash: 'deadbeef' }, llm: { apiKey: 'sk-secret' } });

    const dirMode = fs.statSync(tmpDir).mode & 0o777;
    const cfgMode = fs.statSync(PATHS.config()).mode & 0o777;
    assert.equal(dirMode, 0o700, `~/.multis should be 0700, got ${dirMode.toString(8)}`);
    assert.equal(cfgMode, 0o600, `config.json should be 0600, got ${cfgMode.toString(8)}`);
  });
});
