'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { pathAllowlist, commandAllowlist, combinePolicies } = require('bare-agent/policy');

// Mirrors the governance.json shape that createMultisPolicy reads
const GOV_PATHS = {
  allowed: ['/home/testuser/Documents', '/home/testuser/Projects'],
  denied: ['/etc', '/var', '/usr', '/bin'],
};

const GOV_CMDS = {
  allowlist: ['ls', 'pwd', 'cat', 'grep', 'git'],
  denylist: ['rm', 'sudo', 'dd', 'shutdown'],
};

const cmdPolicy = commandAllowlist({
  allow: GOV_CMDS.allowlist,
  deny: GOV_CMDS.denylist,
  toolName: 'exec',
});

const pathPolicy = pathAllowlist({
  allow: GOV_PATHS.allowed,
  deny: GOV_PATHS.denied,
  toolNames: ['read_file', 'grep_files', 'find_files'],
});

const policy = combinePolicies(cmdPolicy, pathPolicy);

describe('commandAllowlist (replaces isCommandAllowed)', () => {
  it('allows command in allowlist', async () => {
    const r = await cmdPolicy('exec', { command: 'ls -la' });
    assert.strictEqual(r, true);
  });

  it('allows command with arguments', async () => {
    const r = await cmdPolicy('exec', { command: 'git status' });
    assert.strictEqual(r, true);
  });

  it('denies command in denylist', async () => {
    const r = await cmdPolicy('exec', { command: 'rm -rf /' });
    assert.match(r, /denylist/);
  });

  it('denies command not in allowlist', async () => {
    const r = await cmdPolicy('exec', { command: 'echo hello' });
    assert.match(r, /not on the allowlist/);
  });

  it('denylist wins over allowlist', async () => {
    const both = commandAllowlist({ allow: ['rm'], deny: ['rm'], toolName: 'exec' });
    const r = await both('exec', { command: 'rm file.txt' });
    assert.match(r, /denylist/);
  });

  it('passes through tools not named exec', async () => {
    const r = await cmdPolicy('read_file', { path: '/etc/passwd' });
    assert.strictEqual(r, true);
  });
});

describe('pathAllowlist (replaces isPathAllowed)', () => {
  it('allows path in allowed list', async () => {
    const r = await pathPolicy('read_file', { path: '/home/testuser/Documents/report.pdf' });
    assert.strictEqual(r, true);
  });

  it('allows subdirectory of allowed path', async () => {
    const r = await pathPolicy('read_file', { path: '/home/testuser/Projects/multis/src/index.js' });
    assert.strictEqual(r, true);
  });

  it('denies path in denied list', async () => {
    const r = await pathPolicy('read_file', { path: '/etc/passwd' });
    assert.match(r, /denied root/);
  });

  it('denies subdirectory of denied path', async () => {
    const r = await pathPolicy('read_file', { path: '/var/log/syslog' });
    assert.match(r, /denied root/);
  });

  it('denied paths take priority over allowed paths', async () => {
    const strict = pathAllowlist({
      allow: ['/usr/local/share'],
      deny: ['/usr'],
      toolNames: ['read_file'],
    });
    const r = await strict('read_file', { path: '/usr/local/share/doc.txt' });
    assert.match(r, /denied root/);
  });

  it('denies path not in any list', async () => {
    const r = await pathPolicy('read_file', { path: '/opt/random/file.txt' });
    assert.match(r, /not under any allowed root/);
  });

  it('passes through tools not in toolNames', async () => {
    const r = await pathPolicy('exec', { command: 'ls' });
    assert.strictEqual(r, true);
  });
});

describe('combinePolicies (replaces dual governance layer)', () => {
  it('allows when both command and path pass', async () => {
    const r = await policy('exec', { command: 'ls -la' });
    assert.strictEqual(r, true);
  });

  it('denies on command even if path would pass', async () => {
    const r = await policy('exec', { command: 'rm /home/testuser/Documents/x' });
    assert.match(r, /denylist/);
  });

  it('denies on path even if command would pass', async () => {
    const r = await policy('read_file', { path: '/etc/passwd' });
    assert.match(r, /denied root/);
  });

  it('owner routing works via ctx (non-owner denied shell tools)', async () => {
    const withOwner = combinePolicies(policy, async (name, args, ctx) => {
      if (!ctx?.isOwner && ['exec', 'read_file'].includes(name)) return 'Owner only';
      return true;
    });
    const r1 = await withOwner('exec', { command: 'ls' }, { isOwner: true });
    assert.strictEqual(r1, true);
    const r2 = await withOwner('exec', { command: 'ls' }, { isOwner: false });
    assert.strictEqual(r2, 'Owner only');
  });
});
