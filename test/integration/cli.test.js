const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLI = path.join(__dirname, '..', '..', 'bin', 'multis.js');

describe('CLI commands', () => {
  let tmpDir, origHome;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-cli-'));
    origHome = process.env.HOME;
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(args, opts = {}) {
    const env = { ...process.env, HOME: tmpDir, ...opts.env };
    try {
      return { stdout: execSync(`node ${CLI} ${args}`, { encoding: 'utf-8', env, timeout: 10000 }), code: 0 };
    } catch (err) {
      return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status };
    }
  }

  it('no args shows interactive menu', () => {
    const r = run('');
    assert.match(r.stdout, /multis/);
    assert.match(r.stdout, /init|start|stop|status|doctor/);
  });

  it('unknown command prints usage and exits 1', () => {
    const r = run('bogus');
    assert.strictEqual(r.code, 1);
  });

  it('status with no PID file says not running', () => {
    const r = run('status');
    assert.match(r.stdout, /not running/);
  });

  it('stop with no PID file says not running', () => {
    const r = run('stop');
    assert.match(r.stdout, /not running/);
  });

  it('start without config says run init', () => {
    const r = run('start');
    assert.match(r.stdout || r.stderr, /Run: multis init|No config found/);
    assert.notStrictEqual(r.code, 0);
  });

  it('doctor runs checks and reports results', () => {
    // Create minimal config so doctor has something to check
    const multisDir = path.join(tmpDir, '.multis');
    fs.mkdirSync(multisDir, { recursive: true });
    fs.writeFileSync(path.join(multisDir, 'config.json'), JSON.stringify({
      owner_id: 'test1',
      allowed_users: ['test1'],
      llm: { provider: 'ollama' },
      platforms: {}
    }));
    fs.writeFileSync(path.join(multisDir, 'governance.json'), JSON.stringify({
      allowlist: ['.*'], denylist: [], confirm_patterns: []
    }));

    const r = run('doctor');
    assert.match(r.stdout, /Node\.js >= 20/);
    assert.match(r.stdout, /config\.json valid/);
    assert.match(r.stdout, /checks passed/);
  });

  it('status detects stale PID file and cleans up', () => {
    const multisDir = path.join(tmpDir, '.multis');
    fs.mkdirSync(multisDir, { recursive: true });
    // Write a PID that definitely doesn't exist
    fs.writeFileSync(path.join(multisDir, 'multis.pid'), '999999999');

    const r = run('status');
    assert.match(r.stdout, /not running/);
    // PID file should be cleaned up
    assert.strictEqual(fs.existsSync(path.join(multisDir, 'multis.pid')), false);
  });
});
