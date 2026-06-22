const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { BeeperboxMcpClient } = require('../src/platforms/beeperbox-mcp');
const {
  deployLocation,
  isRawBeeperUrl,
  classifyProbeFailure,
  probeHint,
} = require('../src/cli/setup-beeper');

// ---------------------------------------------------------------------------
// Deploy-shape detection (PRD §3f). The discriminator was validated live
// (beeperbox :23375 → JSON-RPC result; raw Beeper :23373 → HTTP 404; nothing
// → ECONNREFUSED). These tests reproduce those exact wire shapes through a
// fake fetch so the classifier is exercised against the REAL error objects the
// client throws — not hand-built stand-ins.
// ---------------------------------------------------------------------------

// Drive the real client to failure with a scripted fetch, return the thrown err.
async function probeError(fetchResponder, { url = 'http://localhost:23375', token = null } = {}) {
  const client = new BeeperboxMcpClient({ url, token, fetchImpl: fetchResponder });
  try {
    await client.listAccounts();
    assert.fail('expected the probe to throw');
  } catch (err) {
    return err;
  }
}

const http404 = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ message: 'Not found', code: 'not_found' }) });
const http401 = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
const connRefused = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };

describe('deployLocation', () => {
  it('labels loopback hosts as local', () => {
    assert.equal(deployLocation('http://localhost:23375'), 'local');
    assert.equal(deployLocation('http://127.0.0.1:23375'), 'local');
    assert.equal(deployLocation('http://[::1]:23375'), 'local');
  });
  it('labels any other host as remote', () => {
    assert.equal(deployLocation('https://box.example.com:23375'), 'remote');
    assert.equal(deployLocation('http://192.168.1.50:23375'), 'remote');
  });
  it('defaults to remote on an unparseable URL (fail safe, not "local")', () => {
    assert.equal(deployLocation('not a url'), 'remote');
  });
});

describe('isRawBeeperUrl', () => {
  it('flags the known raw Beeper Desktop ports', () => {
    assert.equal(isRawBeeperUrl('http://localhost:23373'), true);
    assert.equal(isRawBeeperUrl('http://localhost:23374'), true);
    assert.equal(isRawBeeperUrl('http://localhost:23380'), true);
  });
  it('does not flag the beeperbox MCP port or others', () => {
    assert.equal(isRawBeeperUrl('http://localhost:23375'), false);
    assert.equal(isRawBeeperUrl('https://box.example.com:8443'), false);
  });
});

describe('classifyProbeFailure (against real client errors)', () => {
  it('raw Beeper (HTTP 404) → not-beeperbox', async () => {
    const err = await probeError(http404);
    assert.equal(classifyProbeFailure(err), 'not-beeperbox');
  });
  it('guarded beeperbox (HTTP 401) → needs-token', async () => {
    const err = await probeError(http401);
    assert.equal(classifyProbeFailure(err), 'needs-token');
  });
  it('nothing listening (ECONNREFUSED) → unreachable', async () => {
    const err = await probeError(connRefused);
    assert.equal(classifyProbeFailure(err), 'unreachable');
  });
});

describe('probeHint', () => {
  it('names raw Beeper when the URL is a raw Beeper port', async () => {
    const err = await probeError(http404, { url: 'http://localhost:23373' });
    const hint = probeHint(err, 'http://localhost:23373');
    assert.match(hint, /raw Beeper/i);
    assert.match(hint, /beeperbox/i); // tells them what to run instead
  });
  it('says needs-token on 401, not "raw Beeper"', async () => {
    const err = await probeError(http401, { url: 'https://box.example.com:23375' });
    const hint = probeHint(err, 'https://box.example.com:23375');
    assert.match(hint, /token/i);
    assert.doesNotMatch(hint, /raw Beeper/i);
  });
  it('distinguishes reachable-but-not-beeperbox from unreachable', async () => {
    const notBox = probeHint(await probeError(http404, { url: 'http://localhost:23375' }), 'http://localhost:23375');
    const gone = probeHint(await probeError(connRefused, { url: 'http://localhost:23375' }), 'http://localhost:23375');
    assert.match(notBox, /not a beeperbox/i);
    assert.match(gone, /unreachable/i);
    assert.notEqual(notBox, gone);
  });
});
