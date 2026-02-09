#!/usr/bin/env node
/**
 * Re-login to Beeper with a fresh device, then bootstrap cross-signing.
 *
 * Flow:
 * 1. Login via email code → get new access token + new device ID
 * 2. Start client with fresh crypto → new E2EE keys
 * 3. Bootstrap cross-signing → device becomes verified
 * 4. Save new token to pass
 */

const https = require('https');
const readline = require('readline');
const {
  MatrixClient,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider
} = require('matrix-bot-sdk');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BEEPER_API = 'https://api.beeper.com';
const MATRIX_API = 'https://matrix.beeper.com';
const AUTH_HEADER = 'Bearer BEEPER-PRIVATE-API-PLEASE-DONT-USE';

function httpRequest(url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: body !== null ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...headers }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function apiCall(token, method, endpoint, body) {
  const url = `${MATRIX_API}/_matrix/client/v3${endpoint}`;
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, data: json };
}

async function main() {
  const email = 'avoidaccess@msn.com';
  const storageDir = path.join(__dirname, '..', '.beeper-storage');
  const cryptoDir = path.join(storageDir, 'crypto');

  // Step 1: Clean up old crypto store
  console.log('=== Step 1: Clean up ===');
  if (fs.existsSync(cryptoDir)) {
    fs.rmSync(cryptoDir, { recursive: true });
    console.log('Deleted old crypto store.');
  }
  const botJson = path.join(storageDir, 'bot.json');
  if (fs.existsSync(botJson)) fs.unlinkSync(botJson);

  // Step 2: Login with email code to get a NEW device
  console.log('\n=== Step 2: Beeper login ===');
  console.log(`Email: ${email}`);

  const step1 = await httpRequest(`${BEEPER_API}/user/login`, {}, { Authorization: AUTH_HEADER });
  if (!step1.data.request) {
    console.error('Login init failed:', step1.data);
    process.exit(1);
  }
  console.log('Login initiated.');

  await httpRequest(`${BEEPER_API}/user/login/email`, {
    request: step1.data.request, email
  }, { Authorization: AUTH_HEADER });
  console.log(`Code sent to ${email}.`);

  const code = await ask('Enter the code from your email: ');

  const step3 = await httpRequest(`${BEEPER_API}/user/login/response`, {
    request: step1.data.request, response: code
  }, { Authorization: AUTH_HEADER });

  if (!step3.data.token) {
    console.error('Code exchange failed:', step3.data);
    process.exit(1);
  }
  console.log('Got JWT.');

  // Matrix login - this creates a NEW device
  const loginRes = await httpRequest(`${MATRIX_API}/_matrix/client/v3/login`, {
    type: 'org.matrix.login.jwt', token: step3.data.token
  });

  if (!loginRes.data.access_token) {
    console.error('Matrix login failed:', loginRes.data);
    process.exit(1);
  }

  const newToken = loginRes.data.access_token;
  const newDeviceId = loginRes.data.device_id;
  const userId = loginRes.data.user_id;
  console.log(`\nLogged in as ${userId}`);
  console.log(`New device: ${newDeviceId}`);

  // Set display name
  await apiCall(newToken, 'PUT', `/devices/${newDeviceId}`, { display_name: 'multis bot' });

  // Step 3: Start E2EE client with the new token
  console.log('\n=== Step 3: Initialize E2EE ===');
  const storage = new SimpleFsStorageProvider(botJson);
  const cryptoProvider = new RustSdkCryptoStorageProvider(cryptoDir);
  const client = new MatrixClient(MATRIX_API, newToken, storage, cryptoProvider);

  await client.start({ syncTimeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 8000));

  if (!client.crypto?.isReady) {
    console.error('Crypto not ready!');
    process.exit(1);
  }
  console.log('E2EE initialized.');

  const machine = client.crypto.engine.machine;
  console.log('Device confirmed:', machine.deviceId.toString());

  // Step 4: Process initial outgoing requests
  let outgoing = await machine.outgoingRequests();
  console.log(`\nProcessing ${outgoing.length} initial requests...`);
  for (const req of outgoing) {
    let endpoint;
    if (req.type === 0) endpoint = '/keys/upload';
    else if (req.type === 1) endpoint = '/keys/query';
    else if (req.type === 2) endpoint = '/keys/claim';
    else if (req.type === 4) endpoint = '/keys/signatures/upload';
    else continue;

    const body = JSON.parse(req.body);
    const res = await apiCall(newToken, 'POST', endpoint, body);
    console.log(`  Type ${req.type}: ${res.status}`);
    if (res.status === 200) {
      await machine.markRequestAsSent(req.id, req.type, JSON.stringify(res.data));
    }
  }

  // Step 5: Bootstrap cross-signing
  console.log('\n=== Step 4: Bootstrap cross-signing ===');
  await machine.bootstrapCrossSigning(true);
  console.log('Bootstrap complete.');

  // Process outgoing from bootstrap
  outgoing = await machine.outgoingRequests();
  console.log(`Outgoing after bootstrap: ${outgoing.length}`);
  for (const req of outgoing) {
    let endpoint;
    if (req.type === 0) endpoint = '/keys/upload';
    else if (req.type === 1) endpoint = '/keys/query';
    else if (req.type === 4) endpoint = '/keys/signatures/upload';
    else { console.log(`  Skip type ${req.type}`); continue; }

    const body = JSON.parse(req.body);
    let res = await apiCall(newToken, 'POST', endpoint, body);
    console.log(`  Type ${req.type}: ${res.status}`);

    // Handle UIA for signing keys upload
    if (res.status === 401 && res.data.flows) {
      const session = res.data.session;
      console.log('  UIA required:', res.data.flows.map(f => f.stages));

      // Try with JWT auth since we just logged in
      body.auth = { session, type: 'org.matrix.login.jwt', token: step3.data.token };
      res = await apiCall(newToken, 'POST', endpoint, body);
      console.log('  JWT auth:', res.status);

      if (res.status !== 200) {
        body.auth = { session, type: 'm.login.dummy' };
        res = await apiCall(newToken, 'POST', endpoint, body);
        console.log('  Dummy auth:', res.status);
      }
    }

    if (res.status === 200) {
      try {
        await machine.markRequestAsSent(req.id, req.type, JSON.stringify(res.data));
      } catch (e) { /* may not need marking */ }
      console.log('  OK');
    } else {
      console.log('  Response:', JSON.stringify(res.data).slice(0, 300));
    }
  }

  // Step 6: Verify
  console.log('\n=== Step 5: Verify ===');
  const status = await machine.crossSigningStatus();
  console.log('Cross-signing status:', JSON.stringify(status));

  const keysRes = await apiCall(newToken, 'POST', '/keys/query', {
    device_keys: { [userId]: [newDeviceId] }
  });
  if (keysRes.status === 200) {
    const dev = keysRes.data.device_keys?.[userId]?.[newDeviceId];
    if (dev) {
      const sigs = Object.keys(dev.signatures?.[userId] || {});
      console.log('Device signatures:', sigs);
      console.log('Cross-signed:', sigs.length > 1 ? 'YES!' : 'NO');
    }
    const mk = keysRes.data.master_keys?.[userId];
    if (mk) console.log('New master key:', Object.keys(mk.keys)[0]);
  }

  // Step 7: Save new token
  console.log('\n=== Step 6: Save token ===');
  const passData = `${newToken}\nuser_id: ${userId}\ndevice_id: ${newDeviceId}\nhomeserver: ${MATRIX_API}`;
  try {
    execSync(`printf '%s' "${passData}" | pass insert -m -f multis/beeper_token`, { stdio: 'pipe' });
    console.log('Saved to pass at multis/beeper_token');
  } catch (e) {
    console.error('Failed to save to pass:', e.message);
    console.log('Token:', newToken.slice(0, 20) + '...');
  }

  // List all devices
  const allDevices = await apiCall(newToken, 'GET', '/devices');
  console.log('\nAll devices:');
  for (const d of allDevices.data.devices || []) {
    console.log(`  ${d.device_id}: ${d.display_name || '(unnamed)'}`);
  }

  client.stop();
  console.log('\nDone! New device:', newDeviceId);
  console.log('Run: node scripts/beeper-validate.js');
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
