#!/usr/bin/env node
/**
 * Login + cross-sign in one flow.
 * Gets a JWT via email code, uses it for UIA when uploading cross-signing keys.
 */

const crypto = require('crypto');
const https = require('https');
const readline = require('readline');
const { execSync } = require('child_process');

const BEEPER_API = 'https://api.beeper.com';
const HOMESERVER = 'https://matrix.beeper.com';
const AUTH_HEADER = 'Bearer BEEPER-PRIVATE-API-PLEASE-DONT-USE';

function getToken() {
  return execSync('pass multis/beeper_token', { encoding: 'utf8' }).split('\n')[0].trim();
}

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

async function apiCall(token, method, endpoint, body) {
  const url = `${HOMESERVER}/_matrix/client/v3${endpoint}`;
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

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

function generateKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
  const pubBytes = pubRaw.slice(-32);
  return {
    publicKey: pubBytes.toString('base64').replace(/=+$/, ''),
    privateKey
  };
}

function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function signJson(obj, keyId, privateKey) {
  const copy = { ...obj };
  delete copy.signatures;
  delete copy.unsigned;
  const canonical = canonicalJson(copy);
  const sig = crypto.sign(null, Buffer.from(canonical), privateKey);
  return sig.toString('base64').replace(/=+$/, '');
}

async function main() {
  const matrixToken = getToken();
  console.log('Matrix token loaded.');

  const whoami = await apiCall(matrixToken, 'GET', '/account/whoami');
  const userId = whoami.data.user_id;
  const deviceId = whoami.data.device_id;
  console.log('User:', userId, 'Device:', deviceId);

  // Step 1: Get a fresh JWT for UIA
  console.log('\n=== Get fresh JWT for UIA ===');
  const email = 'avoidaccess@msn.com';

  const step1 = await httpRequest(`${BEEPER_API}/user/login`, {}, { Authorization: AUTH_HEADER });
  if (!step1.data.request) {
    console.error('Login init failed:', step1.data);
    process.exit(1);
  }

  await httpRequest(`${BEEPER_API}/user/login/email`, {
    request: step1.data.request, email
  }, { Authorization: AUTH_HEADER });
  console.log(`Code sent to ${email}.`);

  const code = await ask('Enter the code: ');

  const step3 = await httpRequest(`${BEEPER_API}/user/login/response`, {
    request: step1.data.request, response: code
  }, { Authorization: AUTH_HEADER });

  if (!step3.data.token) {
    console.error('Code exchange failed:', step3.data);
    process.exit(1);
  }
  const jwt = step3.data.token;
  console.log('Got fresh JWT.');

  // Step 2: Get device keys from server
  const keysRes = await apiCall(matrixToken, 'POST', '/keys/query', {
    device_keys: { [userId]: [deviceId] }
  });
  const deviceKeys = keysRes.data.device_keys?.[userId]?.[deviceId];
  console.log('Device keys found:', !!deviceKeys);

  // Step 3: Generate cross-signing keys
  console.log('\n=== Generate cross-signing keys ===');
  const master = generateKey();
  const selfSigning = generateKey();
  const userSigning = generateKey();

  const masterKeyId = `ed25519:${master.publicKey}`;
  const selfSigningKeyId = `ed25519:${selfSigning.publicKey}`;
  const userSigningKeyId = `ed25519:${userSigning.publicKey}`;
  console.log('Master:', master.publicKey.slice(0, 20) + '...');
  console.log('Self-signing:', selfSigning.publicKey.slice(0, 20) + '...');

  // Build key objects
  const masterKeyObj = {
    user_id: userId,
    usage: ['master'],
    keys: { [masterKeyId]: master.publicKey },
  };

  const selfSigningKeyObj = {
    user_id: userId,
    usage: ['self_signing'],
    keys: { [selfSigningKeyId]: selfSigning.publicKey },
  };

  const userSigningKeyObj = {
    user_id: userId,
    usage: ['user_signing'],
    keys: { [userSigningKeyId]: userSigning.publicKey },
  };

  // Sign sub-keys with master
  selfSigningKeyObj.signatures = {
    [userId]: { [masterKeyId]: signJson(selfSigningKeyObj, masterKeyId, master.privateKey) }
  };
  userSigningKeyObj.signatures = {
    [userId]: { [masterKeyId]: signJson(userSigningKeyObj, masterKeyId, master.privateKey) }
  };

  // Step 4: Upload cross-signing keys WITH JWT UIA
  console.log('\n=== Upload cross-signing keys ===');
  const uploadBody = {
    master_key: masterKeyObj,
    self_signing_key: selfSigningKeyObj,
    user_signing_key: userSigningKeyObj,
  };

  // First call to get UIA session
  let res = await apiCall(matrixToken, 'POST', '/keys/device_signing/upload', uploadBody);
  console.log('Initial:', res.status);

  if (res.status === 401 && res.data.session) {
    const session = res.data.session;
    console.log('UIA session:', session);

    // Use JWT for auth
    uploadBody.auth = {
      session,
      type: 'org.matrix.login.jwt',
      token: jwt
    };
    res = await apiCall(matrixToken, 'POST', '/keys/device_signing/upload', uploadBody);
    console.log('With JWT UIA:', res.status);

    if (res.status !== 200) {
      console.log('Response:', JSON.stringify(res.data).slice(0, 300));
    }
  }

  if (res.status !== 200) {
    console.error('FAILED to upload signing keys!');
    process.exit(1);
  }
  console.log('Cross-signing keys uploaded!');

  // Step 5: Sign device with self-signing key and upload
  console.log('\n=== Sign device ===');
  const deviceToSign = {
    user_id: userId,
    device_id: deviceId,
    algorithms: deviceKeys.algorithms,
    keys: deviceKeys.keys,
  };

  const deviceSig = signJson(deviceToSign, selfSigningKeyId, selfSigning.privateKey);

  const sigUpload = {
    [userId]: {
      [deviceId]: {
        user_id: userId,
        device_id: deviceId,
        algorithms: deviceKeys.algorithms,
        keys: deviceKeys.keys,
        signatures: {
          [userId]: {
            ...deviceKeys.signatures?.[userId],
            [selfSigningKeyId]: deviceSig,
          }
        }
      }
    }
  };

  res = await apiCall(matrixToken, 'POST', '/keys/signatures/upload', sigUpload);
  console.log('Signature upload:', res.status);
  if (res.data.failures && Object.keys(res.data.failures).length > 0) {
    console.log('Failures:', JSON.stringify(res.data.failures));
  } else {
    console.log('Device signed!');
  }

  // Step 6: Verify
  console.log('\n=== Verify ===');
  const verifyRes = await apiCall(matrixToken, 'POST', '/keys/query', {
    device_keys: { [userId]: [deviceId] }
  });
  const dev = verifyRes.data.device_keys?.[userId]?.[deviceId];
  if (dev) {
    const sigs = Object.keys(dev.signatures?.[userId] || {});
    console.log('Device signatures:', sigs);
    console.log('Cross-signed:', sigs.length > 1 ? 'YES!' : 'NO');
  }
  const mk = verifyRes.data.master_keys?.[userId];
  if (mk) console.log('Master key:', Object.keys(mk.keys)[0]);
  const sk = verifyRes.data.self_signing_keys?.[userId];
  if (sk) console.log('Self-signing:', Object.keys(sk.keys)[0]);

  console.log('\nDone! Now run: node scripts/beeper-validate.js');
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
