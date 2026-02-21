const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const NODE = process.execPath;

function requireModule(modulePath) {
  execFileSync(NODE, ['-e', `require('${modulePath}')`], {
    cwd: ROOT,
    timeout: 10000,
    stdio: 'pipe',
  });
}

// ---------------------------------------------------------------------------
// Module loading smoke tests — ensure no missing requires or syntax errors
// ---------------------------------------------------------------------------

describe('Module loading (smoke)', () => {
  it('loads src/bot/handlers', () => {
    requireModule('./src/bot/handlers');
  });

  it('loads src/llm/provider-adapter', () => {
    requireModule('./src/llm/provider-adapter');
  });

  it('loads src/bot/scheduler', () => {
    requireModule('./src/bot/scheduler');
  });

  it('loads src/bot/checkpoint', () => {
    requireModule('./src/bot/checkpoint');
  });

  it('loads src/tools/adapter', () => {
    requireModule('./src/tools/adapter');
  });

  it('loads src/tools/registry', () => {
    requireModule('./src/tools/registry');
  });
});

// ---------------------------------------------------------------------------
// CLI smoke — doctor exits without crash
// ---------------------------------------------------------------------------

describe('CLI smoke', () => {
  it('multis doctor exits cleanly', () => {
    const result = execFileSync(NODE, ['bin/multis.js', 'doctor'], {
      cwd: ROOT,
      timeout: 15000,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    assert.match(result, /checks passed/);
  });
});
