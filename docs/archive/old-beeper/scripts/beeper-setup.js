#!/usr/bin/env node
/**
 * Beeper/Matrix setup script.
 * Handles: login, E2EE device registration, cross-signing, recovery key (SSSS).
 *
 * Outputs all device/key/encryption details to ~/.multis/beeper-device.json
 *
 * Usage: node scripts/beeper-setup.js [email]
 *   Default email: avoidaccess@msn.com
 */

const crypto = require('crypto');
const https = require('https');
const readline = require('readline');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BEEPER_API = 'https://api.beeper.com';
const HOMESERVER = 'https://matrix.beeper.com';
const AUTH_HEADER = 'Bearer BEEPER-PRIVATE-API-PLEASE-DONT-USE';
const DEVICE_FILE = path.join(process.env.HOME, '.multis', 'beeper-device.json');

// --- HTTP helpers ---

function httpRequest(url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
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

async function matrixApi(token, method, endpoint, body) {
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

// --- Crypto helpers ---

function generateEd25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pubBytes = pubDer.slice(-32);
  const privBytes = privDer.slice(-32);
  return {
    publicKey: pubBytes.toString('base64').replace(/=+$/, ''),
    privateKeyBase64: privBytes.toString('base64').replace(/=+$/, ''),
    privateKeyObject: privateKey,
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

// --- SSSS / Recovery Key ---

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let num = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let result = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    result = BASE58_ALPHABET[remainder] + result;
  }
  // Leading zeros
  for (const b of bytes) {
    if (b === 0) result = '1' + result;
    else break;
  }
  return result;
}

function generateRecoveryKey() {
  const rawKey = crypto.randomBytes(32);
  // Encode: prefix [0x8B, 0x01] + key + parity
  const withPrefix = Buffer.concat([Buffer.from([0x8B, 0x01]), rawKey]);
  let parity = 0;
  for (const b of withPrefix) parity ^= b;
  const full = Buffer.concat([withPrefix, Buffer.from([parity])]);
  const encoded = base58Encode(full);
  // Format in groups of 4
  const formatted = encoded.match(/.{1,4}/g).join(' ');
  return { rawKey, encoded: formatted };
}

async function deriveKeys(rawKey, name) {
  const hkdfKey = await crypto.subtle.importKey('raw', rawKey, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF',
    salt: new Uint8Array(8),
    info: new TextEncoder().encode(name),
    hash: 'SHA-256'
  }, hkdfKey, 512);
  return {
    aesKey: Buffer.from(bits.slice(0, 32)),
    hmacKey: Buffer.from(bits.slice(32)),
  };
}

async function encryptSecret(plaintext, rawKey, name) {
  const { aesKey, hmacKey } = await deriveKeys(rawKey, name);
  const iv = crypto.randomBytes(16);
  iv[8] &= 0x7F; // Clear bit 63 for Android compat

  const aesKeyObj = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CTR' }, false, ['encrypt']);
  const ciphertext = Buffer.from(await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    aesKeyObj,
    new TextEncoder().encode(plaintext)
  ));

  const hmacKeyObj = await crypto.subtle.importKey('raw', hmacKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Buffer.from(await crypto.subtle.sign('HMAC', hmacKeyObj, ciphertext));

  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    mac: mac.toString('base64'),
  };
}

// --- Main flow ---

async function main() {
  const email = process.argv[2] || 'avoidaccess@msn.com';
  console.log('=== Beeper/Matrix Setup ===\n');

  // Step 1: Clean old state
  const storageDir = path.join(__dirname, '..', '.beeper-storage');
  const cryptoDir = path.join(storageDir, 'crypto');
  if (fs.existsSync(cryptoDir)) {
    fs.rmSync(cryptoDir, { recursive: true });
    console.log('[cleanup] Removed old crypto store.');
  }
  const botJson = path.join(storageDir, 'bot.json');
  if (fs.existsSync(botJson)) fs.unlinkSync(botJson);

  // Step 2: Login
  console.log(`\n[login] Email: ${email}`);
  const step1 = await httpRequest(`${BEEPER_API}/user/login`, {}, { Authorization: AUTH_HEADER });
  if (!step1.data.request) {
    console.error('Login init failed:', step1.data);
    process.exit(1);
  }

  await httpRequest(`${BEEPER_API}/user/login/email`, {
    request: step1.data.request, email
  }, { Authorization: AUTH_HEADER });
  console.log(`[login] Code sent to ${email}`);

  const code = await ask('Enter the code from your email: ');

  const step3 = await httpRequest(`${BEEPER_API}/user/login/response`, {
    request: step1.data.request, response: code
  }, { Authorization: AUTH_HEADER });
  if (!step3.data.token) {
    console.error('Code exchange failed:', step3.data);
    process.exit(1);
  }
  const jwt = step3.data.token;

  const loginRes = await httpRequest(`${HOMESERVER}/_matrix/client/v3/login`, {
    type: 'org.matrix.login.jwt', token: jwt
  });
  if (!loginRes.data.access_token) {
    console.error('Matrix login failed:', loginRes.data);
    process.exit(1);
  }

  const token = loginRes.data.access_token;
  const userId = loginRes.data.user_id;
  const deviceId = loginRes.data.device_id;
  console.log(`[login] OK — user: ${userId}, device: ${deviceId}`);

  // Name the device
  await matrixApi(token, 'PUT', `/devices/${deviceId}`, { display_name: 'multis bot' });

  // Step 3: Initialize E2EE
  console.log('\n[e2ee] Initializing...');
  const {
    MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider
  } = require('matrix-bot-sdk');

  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
  const storage = new SimpleFsStorageProvider(botJson);
  const cryptoProvider = new RustSdkCryptoStorageProvider(cryptoDir);
  const client = new MatrixClient(HOMESERVER, token, storage, cryptoProvider);

  await client.start({ syncTimeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 8000));

  if (!client.crypto?.isReady) {
    console.error('Crypto failed to initialize!');
    process.exit(1);
  }
  console.log('[e2ee] Ready. Device:', client.crypto.engine.machine.deviceId.toString());
  client.stop();

  // Get device keys from server
  const keysRes = await matrixApi(token, 'POST', '/keys/query', {
    device_keys: { [userId]: [deviceId] }
  });
  const deviceKeys = keysRes.data.device_keys?.[userId]?.[deviceId];
  if (!deviceKeys) {
    console.error('Device keys not found on server!');
    process.exit(1);
  }

  const deviceEd25519 = deviceKeys.keys[`ed25519:${deviceId}`];
  const deviceCurve25519 = deviceKeys.keys[`curve25519:${deviceId}`];

  // Step 4: Generate cross-signing keys
  console.log('\n[cross-signing] Generating keys...');
  const master = generateEd25519();
  const selfSigning = generateEd25519();
  const userSigning = generateEd25519();

  const masterKeyId = `ed25519:${master.publicKey}`;
  const selfSigningKeyId = `ed25519:${selfSigning.publicKey}`;
  const userSigningKeyId = `ed25519:${userSigning.publicKey}`;

  // Build key objects
  const masterKeyObj = {
    user_id: userId, usage: ['master'],
    keys: { [masterKeyId]: master.publicKey },
  };
  const selfSigningKeyObj = {
    user_id: userId, usage: ['self_signing'],
    keys: { [selfSigningKeyId]: selfSigning.publicKey },
  };
  const userSigningKeyObj = {
    user_id: userId, usage: ['user_signing'],
    keys: { [userSigningKeyId]: userSigning.publicKey },
  };

  // Sign sub-keys with master
  selfSigningKeyObj.signatures = {
    [userId]: { [masterKeyId]: signJson(selfSigningKeyObj, masterKeyId, master.privateKeyObject) }
  };
  userSigningKeyObj.signatures = {
    [userId]: { [masterKeyId]: signJson(userSigningKeyObj, masterKeyId, master.privateKeyObject) }
  };

  // Upload cross-signing keys with JWT UIA
  console.log('[cross-signing] Uploading...');
  const uploadBody = {
    master_key: masterKeyObj,
    self_signing_key: selfSigningKeyObj,
    user_signing_key: userSigningKeyObj,
  };

  let res = await matrixApi(token, 'POST', '/keys/device_signing/upload', uploadBody);
  if (res.status === 401 && res.data.session) {
    uploadBody.auth = { session: res.data.session, type: 'org.matrix.login.jwt', token: jwt };
    res = await matrixApi(token, 'POST', '/keys/device_signing/upload', uploadBody);
  }
  if (res.status !== 200) {
    console.error('[cross-signing] Upload FAILED:', JSON.stringify(res.data).slice(0, 300));
    process.exit(1);
  }
  console.log('[cross-signing] Keys uploaded.');

  // Sign device with self-signing key
  console.log('[cross-signing] Signing device...');
  const deviceToSign = {
    user_id: userId, device_id: deviceId,
    algorithms: deviceKeys.algorithms, keys: deviceKeys.keys,
  };
  const deviceSig = signJson(deviceToSign, selfSigningKeyId, selfSigning.privateKeyObject);

  const sigUpload = {
    [userId]: {
      [deviceId]: {
        user_id: userId, device_id: deviceId,
        algorithms: deviceKeys.algorithms, keys: deviceKeys.keys,
        signatures: {
          [userId]: {
            ...deviceKeys.signatures?.[userId],
            [selfSigningKeyId]: deviceSig,
          }
        }
      }
    }
  };
  res = await matrixApi(token, 'POST', '/keys/signatures/upload', sigUpload);
  const sigFailed = res.data.failures && Object.keys(res.data.failures).length > 0;
  if (sigFailed) {
    console.error('[cross-signing] Signature failed:', JSON.stringify(res.data.failures));
    process.exit(1);
  }
  console.log('[cross-signing] Device signed.');

  // Step 5: Setup SSSS recovery key
  console.log('\n[recovery] Generating recovery key...');
  const recovery = generateRecoveryKey();
  const ssssKeyId = crypto.randomBytes(16).toString('hex');

  // Key check: encrypt 32 zero bytes with empty name
  const keyCheck = await encryptSecret('\0'.repeat(32), recovery.rawKey, '');

  // Store key metadata
  await matrixApi(token, 'PUT', `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.key.${ssssKeyId}`, {
    algorithm: 'm.secret_storage.v1.aes-hmac-sha2',
    name: 'Recovery Key',
    iv: keyCheck.iv,
    mac: keyCheck.mac,
  });

  // Set as default key
  await matrixApi(token, 'PUT', `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`, {
    key: ssssKeyId,
  });

  // Encrypt and store cross-signing private keys
  const secrets = {
    'm.cross_signing.master': master.privateKeyBase64,
    'm.cross_signing.self_signing': selfSigning.privateKeyBase64,
    'm.cross_signing.user_signing': userSigning.privateKeyBase64,
  };

  for (const [name, privKey] of Object.entries(secrets)) {
    const encrypted = await encryptSecret(privKey, recovery.rawKey, name);
    await matrixApi(token, 'PUT', `/user/${encodeURIComponent(userId)}/account_data/${name}`, {
      encrypted: { [ssssKeyId]: encrypted }
    });
  }
  console.log('[recovery] SSSS setup complete.');

  // Step 6: Verify everything
  console.log('\n[verify] Checking server state...');
  const verifyRes = await matrixApi(token, 'POST', '/keys/query', {
    device_keys: { [userId]: [deviceId] }
  });
  const dev = verifyRes.data.device_keys?.[userId]?.[deviceId];
  const sigs = Object.keys(dev?.signatures?.[userId] || {});
  const crossSigned = sigs.length > 1;

  const allDevices = await matrixApi(token, 'GET', '/devices');
  const devices = (allDevices.data.devices || []).map(d => ({
    id: d.device_id,
    name: d.display_name || '(unnamed)',
    last_seen: d.last_seen_ts ? new Date(d.last_seen_ts).toISOString() : null,
  }));

  // Step 7: Save everything
  const deviceInfo = {
    _comment: 'Generated by beeper-setup.js. DO NOT share recovery_key or token.',
    created: new Date().toISOString(),
    homeserver: HOMESERVER,
    user_id: userId,
    device: {
      id: deviceId,
      name: 'multis bot',
      ed25519: deviceEd25519,
      curve25519: deviceCurve25519,
      cross_signed: crossSigned,
      signatures: sigs,
    },
    cross_signing: {
      master_key: master.publicKey,
      self_signing_key: selfSigning.publicKey,
      user_signing_key: userSigning.publicKey,
    },
    recovery: {
      key_id: ssssKeyId,
      recovery_key: recovery.encoded,
    },
    encryption: {
      algorithms: deviceKeys.algorithms,
      ssss_algorithm: 'm.secret_storage.v1.aes-hmac-sha2',
    },
    all_devices: devices,
  };

  // Ensure ~/.multis exists
  const multisDir = path.dirname(DEVICE_FILE);
  if (!fs.existsSync(multisDir)) fs.mkdirSync(multisDir, { recursive: true });
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(deviceInfo, null, 2));

  // Save token to pass
  const passData = `${token}\nuser_id: ${userId}\ndevice_id: ${deviceId}\nhomeserver: ${HOMESERVER}`;
  try {
    execSync(`printf '%s' "${passData}" | pass insert -m -f multis/beeper_token`, { stdio: 'pipe' });
  } catch (e) {
    console.error('[pass] Failed to save token:', e.message);
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('  BEEPER SETUP COMPLETE');
  console.log('='.repeat(60));
  console.log(`  User:          ${userId}`);
  console.log(`  Device:        ${deviceId} (multis bot)`);
  console.log(`  Ed25519:       ${deviceEd25519}`);
  console.log(`  Curve25519:    ${deviceCurve25519}`);
  console.log(`  Cross-signed:  ${crossSigned ? 'YES' : 'NO'}`);
  console.log(`  Master key:    ${master.publicKey.slice(0, 20)}...`);
  console.log(`  Self-signing:  ${selfSigning.publicKey.slice(0, 20)}...`);
  console.log('');
  console.log(`  Recovery key:  ${recovery.encoded}`);
  console.log('');
  console.log(`  Token:         pass multis/beeper_token`);
  console.log(`  Device file:   ${DEVICE_FILE}`);
  console.log(`  Crypto store:  ${cryptoDir}`);
  console.log('');
  console.log(`  Devices on account: ${devices.length}`);
  for (const d of devices) {
    console.log(`    ${d.id}: ${d.name}`);
  }
  console.log('='.repeat(60));
  console.log('\n  Save the recovery key! Enter it on Beeper iOS to verify.\n');
  console.log('  Test: node scripts/beeper-validate.js 300');
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
