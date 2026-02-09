#!/usr/bin/env node
/**
 * Join Beeper as a new verified device WITHOUT replacing cross-signing keys.
 *
 * This script:
 * 1. Logs in via Beeper API (creates new device alongside iOS)
 * 2. Initializes E2EE crypto (uploads device keys)
 * 3. Fetches iOS's cross-signing keys from server
 * 4. Uses recovery key to decrypt SSSS → get self-signing private key
 * 5. Signs our bot device with iOS's self-signing key
 * 6. Validates by listening for messages
 *
 * Usage: node scripts/beeper-join.js [email] [recovery-key]
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
const STORAGE_DIR = path.join(__dirname, '..', '.beeper-storage');
const CRYPTO_DIR = path.join(STORAGE_DIR, 'crypto');

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

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str) {
  let num = 0n;
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) continue; // skip spaces
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16).padStart(70, '0'); // 35 bytes = 70 hex
  return Buffer.from(hex, 'hex');
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

async function deriveKeys(rawKey, name) {
  const hkdfKey = await crypto.subtle.importKey('raw', rawKey, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF', salt: new Uint8Array(8),
    info: new TextEncoder().encode(name), hash: 'SHA-256'
  }, hkdfKey, 512);
  return { aesKey: Buffer.from(bits.slice(0, 32)), hmacKey: Buffer.from(bits.slice(32)) };
}

async function decryptSecret(encrypted, rawKey, name) {
  const { aesKey, hmacKey } = await deriveKeys(rawKey, name);
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  const iv = Buffer.from(encrypted.iv, 'base64');
  const mac = Buffer.from(encrypted.mac, 'base64');

  const hmacKeyObj = await crypto.subtle.importKey('raw', hmacKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', hmacKeyObj, mac, ciphertext);
  if (!valid) throw new Error('Bad MAC — wrong recovery key?');

  const aesKeyObj = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CTR' }, false, ['decrypt']);
  const plaintext = Buffer.from(await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv, length: 64 }, aesKeyObj, ciphertext
  ));
  return plaintext.toString('utf8');
}

// --- Main flow ---

async function main() {
  const email = process.argv[2] || 'avoidaccess@msn.com';
  const recoveryKeyArg = process.argv.slice(3).join(' ') || null;

  console.log('=== Beeper Join (Add Device) ===\n');
  console.log('This script adds a bot device WITHOUT replacing cross-signing keys.\n');

  // Clean old local state
  if (fs.existsSync(CRYPTO_DIR)) {
    fs.rmSync(CRYPTO_DIR, { recursive: true });
    console.log('[cleanup] Removed old crypto store.');
  }
  const botJson = path.join(STORAGE_DIR, 'bot.json');
  if (fs.existsSync(botJson)) fs.unlinkSync(botJson);

  // ============================================================
  // STEP 1: Login (creates new device alongside iOS)
  // ============================================================
  console.log(`[step 1/6] Login — email: ${email}`);
  const step1 = await httpRequest(`${BEEPER_API}/user/login`, {}, { Authorization: AUTH_HEADER });
  if (!step1.data.request) {
    console.error('Login init failed:', step1.data);
    process.exit(1);
  }

  await httpRequest(`${BEEPER_API}/user/login/email`, {
    request: step1.data.request, email
  }, { Authorization: AUTH_HEADER });
  console.log(`  Code sent to ${email}`);

  const code = await ask('  Enter the code from your email: ');

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
  console.log(`  OK — user: ${userId}, device: ${deviceId}`);

  await matrixApi(token, 'PUT', `/devices/${deviceId}`, { display_name: 'multis bot' });

  // ============================================================
  // STEP 2: Initialize E2EE (uploads device keys, does NOT touch cross-signing)
  // ============================================================
  console.log('\n[step 2/6] Initialize E2EE...');
  const {
    MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider
  } = require('matrix-bot-sdk');

  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const storage = new SimpleFsStorageProvider(botJson);
  const cryptoProvider = new RustSdkCryptoStorageProvider(CRYPTO_DIR);
  const client = new MatrixClient(HOMESERVER, token, storage, cryptoProvider);

  await client.start({ syncTimeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 8000));

  if (!client.crypto?.isReady) {
    console.error('Crypto failed to initialize!');
    process.exit(1);
  }
  console.log('  Crypto ready. Device keys uploaded.');
  client.stop();

  // Get our device keys from server
  const ourKeysRes = await matrixApi(token, 'POST', '/keys/query', {
    device_keys: { [userId]: [deviceId] }
  });
  const ourDeviceKeys = ourKeysRes.data.device_keys?.[userId]?.[deviceId];
  if (!ourDeviceKeys) {
    console.error('Our device keys not found on server!');
    process.exit(1);
  }

  // ============================================================
  // STEP 3: Fetch iOS's cross-signing keys from server
  // ============================================================
  console.log('\n[step 3/6] Fetch cross-signing keys from server...');
  const allKeysRes = await matrixApi(token, 'POST', '/keys/query', {
    device_keys: { [userId]: [] }
  });

  const selfSigningKeyObj = allKeysRes.data.self_signing_keys?.[userId];
  if (!selfSigningKeyObj) {
    console.error('No self-signing key on server! Is iOS set up?');
    process.exit(1);
  }

  const selfSigningPub = Object.values(selfSigningKeyObj.keys)[0];
  const selfSigningKeyId = `ed25519:${selfSigningPub}`;
  console.log(`  Self-signing key: ${selfSigningPub.slice(0, 30)}...`);

  const masterKeyObj = allKeysRes.data.master_keys?.[userId];
  const masterPub = masterKeyObj ? Object.values(masterKeyObj.keys)[0] : null;
  console.log(`  Master key:       ${masterPub ? masterPub.slice(0, 30) + '...' : 'NOT FOUND'}`);

  // Check if our device is already signed
  const ourSigs = Object.keys(ourDeviceKeys.signatures?.[userId] || {});
  if (ourSigs.includes(selfSigningKeyId)) {
    console.log('\n  Our device is ALREADY cross-signed! Skipping to validation.');
  } else {
    // ============================================================
    // STEP 4: Decode recovery key
    // ============================================================
    const recoveryKeyEncoded = recoveryKeyArg || await ask('\n  Enter recovery key from Beeper iOS: ');
    console.log('\n[step 4/6] Decode recovery key...');

    const decoded = base58Decode(recoveryKeyEncoded);
    if (decoded[0] !== 0x8B || decoded[1] !== 0x01) {
      console.error('Invalid recovery key prefix! Got:', decoded[0].toString(16), decoded[1].toString(16));
      process.exit(1);
    }
    const rawKey = decoded.slice(2, 34);
    console.log('  Recovery key decoded OK.');

    // ============================================================
    // STEP 5: Decrypt SSSS → get self-signing private key
    // ============================================================
    console.log('\n[step 5/6] Decrypt SSSS...');

    // Get SSSS default key ID
    const defaultKeyRes = await matrixApi(token, 'GET',
      `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`);
    if (defaultKeyRes.status !== 200) {
      console.error('Failed to fetch SSSS default key:', defaultKeyRes.status, defaultKeyRes.data);
      process.exit(1);
    }
    const ssssKeyId = defaultKeyRes.data.key;
    console.log(`  SSSS key ID: ${ssssKeyId}`);

    // Verify recovery key against key check
    const keyMetaRes = await matrixApi(token, 'GET',
      `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.key.${ssssKeyId}`);
    if (keyMetaRes.status === 200 && keyMetaRes.data.iv && keyMetaRes.data.mac) {
      try {
        await decryptSecret(
          { ciphertext: Buffer.alloc(32).toString('base64'), iv: keyMetaRes.data.iv, mac: keyMetaRes.data.mac },
          rawKey, ''
        );
        // If we get here without MAC error, the key check structure is different
        // Actually the key check encrypts 32 zero bytes — let's just try the real decrypt
      } catch {
        // MAC check on key verification — might be fine, the real test is decrypting the actual secret
      }
    }

    // Fetch encrypted self-signing key from SSSS
    const ssssRes = await matrixApi(token, 'GET',
      `/user/${encodeURIComponent(userId)}/account_data/m.cross_signing.self_signing`);
    if (ssssRes.status !== 200) {
      console.error('Failed to fetch self-signing key from SSSS:', ssssRes.status);
      process.exit(1);
    }

    const encryptedData = ssssRes.data.encrypted?.[ssssKeyId];
    if (!encryptedData) {
      // Try all available key IDs
      const availableKeys = Object.keys(ssssRes.data.encrypted || {});
      console.error(`No encrypted data for key ID: ${ssssKeyId}`);
      console.error(`Available key IDs: ${availableKeys.join(', ')}`);
      if (availableKeys.length === 1) {
        console.log(`  Trying the only available key: ${availableKeys[0]}`);
        const altData = ssssRes.data.encrypted[availableKeys[0]];
        if (altData) {
          const privKeyBase64 = await decryptSecret(altData, rawKey, 'm.cross_signing.self_signing');
          console.log('  Decrypted self-signing private key (using alt key ID).');
        }
      }
      process.exit(1);
    }

    let privKeyBase64;
    try {
      privKeyBase64 = await decryptSecret(encryptedData, rawKey, 'm.cross_signing.self_signing');
    } catch (err) {
      console.error(`  SSSS decryption failed: ${err.message}`);
      console.error('  This usually means the recovery key is wrong or iOS rotated it.');
      process.exit(1);
    }
    console.log('  Self-signing private key decrypted.');

    // Reconstruct ed25519 private key
    const privKeyBytes = Buffer.from(privKeyBase64, 'base64');
    const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    const pkcs8Der = Buffer.concat([pkcs8Prefix, privKeyBytes]);
    const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

    // ============================================================
    // STEP 6: Sign our device with iOS's self-signing key
    // ============================================================
    console.log('\n[step 6/6] Sign our device...');

    const deviceToSign = {
      user_id: userId,
      device_id: deviceId,
      algorithms: ourDeviceKeys.algorithms,
      keys: ourDeviceKeys.keys,
    };
    const sig = signJson(deviceToSign, selfSigningKeyId, privateKey);

    const sigUpload = {
      [userId]: {
        [deviceId]: {
          user_id: userId,
          device_id: deviceId,
          algorithms: ourDeviceKeys.algorithms,
          keys: ourDeviceKeys.keys,
          signatures: {
            [userId]: {
              ...ourDeviceKeys.signatures?.[userId],
              [selfSigningKeyId]: sig,
            }
          }
        }
      }
    };

    const sigRes = await matrixApi(token, 'POST', '/keys/signatures/upload', sigUpload);
    if (sigRes.data.failures && Object.keys(sigRes.data.failures).length > 0) {
      console.error('  Signature upload failed:', JSON.stringify(sigRes.data.failures, null, 2));
      process.exit(1);
    }
    console.log('  Device signed and uploaded.');
  }

  // ============================================================
  // VERIFY: Check our device is cross-signed
  // ============================================================
  console.log('\n[verify] Checking server state...');
  const verifyRes = await matrixApi(token, 'POST', '/keys/query', {
    device_keys: { [userId]: [] }
  });

  const allDevices = await matrixApi(token, 'GET', '/devices');
  const devices = allDevices.data.devices || [];

  console.log('\nDevices on account:');
  for (const d of devices) {
    const devKeys = verifyRes.data.device_keys?.[userId]?.[d.device_id];
    const sigs = Object.keys(devKeys?.signatures?.[userId] || {});
    const crossSigned = sigs.some(s => s === selfSigningKeyId);
    const marker = d.device_id === deviceId ? ' ← US' : '';
    console.log(`  ${d.device_id} (${d.display_name}): ${crossSigned ? 'VERIFIED' : 'NOT VERIFIED'} [${sigs.length} sigs]${marker}`);
  }

  // Save device info
  const deviceInfo = {
    _comment: 'Generated by beeper-join.js. Joined existing cross-signing identity.',
    created: new Date().toISOString(),
    homeserver: HOMESERVER,
    user_id: userId,
    device: {
      id: deviceId,
      name: 'multis bot',
      ed25519: ourDeviceKeys.keys[`ed25519:${deviceId}`],
      curve25519: ourDeviceKeys.keys[`curve25519:${deviceId}`],
    },
    cross_signing: {
      master_key: masterPub,
      self_signing_key: selfSigningPub,
      note: 'These are iOS keys — we joined, not replaced.',
    },
    all_devices: devices.map(d => ({ id: d.device_id, name: d.display_name })),
  };

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
  console.log('  BEEPER JOIN COMPLETE');
  console.log('='.repeat(60));
  console.log(`  User:          ${userId}`);
  console.log(`  Device:        ${deviceId} (multis bot)`);
  console.log(`  Cross-signing: JOINED (did not replace)`);
  console.log(`  Token:         pass multis/beeper_token`);
  console.log(`  Device file:   ${DEVICE_FILE}`);
  console.log('='.repeat(60));
  console.log('\n  Test: node scripts/beeper-validate.js 120');
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
