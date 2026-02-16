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

  it('merges business.escalation defaults', () => {
    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const config = loadConfig();

    assert.strictEqual(config.business.escalation.max_retries_before_escalate, 2);
    assert.ok(Array.isArray(config.business.escalation.escalate_keywords));
    assert.ok(config.business.escalation.escalate_keywords.includes('refund'));
    assert.ok(Array.isArray(config.business.escalation.allowed_urls));
  });

  it('merges memory defaults', () => {
    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const config = loadConfig();

    assert.strictEqual(config.memory.enabled, true);
    assert.strictEqual(config.memory.recent_window, 20);
    assert.strictEqual(config.memory.capture_threshold, 10);
    assert.strictEqual(config.memory.decay_rate, 0.05);
    assert.strictEqual(config.memory.memory_max_sections, 12);
    assert.strictEqual(config.memory.retention_days, 90);
    assert.strictEqual(config.memory.admin_retention_days, 365);
    assert.strictEqual(config.memory.log_retention_days, 30);
  });

  it('preserves custom memory values', () => {
    const multisDir = path.join(tmpDir, '.multis');
    const config = JSON.parse(fs.readFileSync(path.join(multisDir, 'config.json'), 'utf-8'));
    config.memory = { retention_days: 180, enabled: false };
    fs.writeFileSync(path.join(multisDir, 'config.json'), JSON.stringify(config, null, 2));

    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const loaded = loadConfig();

    assert.strictEqual(loaded.memory.retention_days, 180);
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
