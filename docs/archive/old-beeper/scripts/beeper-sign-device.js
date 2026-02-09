#!/usr/bin/env node
/**
 * Sign another device with the self-signing key.
 * Fetches the self-signing private key from SSSS using the recovery key.
 *
 * Usage: node scripts/beeper-sign-device.js [DEVICE_ID]
 *   Defaults to signing all unverified devices on the account.
 */

const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOMESERVER = 'https://matrix.beeper.com';
const DEVICE_FILE = path.join(process.env.HOME, '.multis', 'beeper-device.json');

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

function getToken() {
  return execSync('pass multis/beeper_token', { encoding: 'utf8' }).split('\n')[0].trim();
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

  // Verify HMAC
  const hmacKeyObj = await crypto.subtle.importKey('raw', hmacKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', hmacKeyObj, mac, ciphertext);
  if (!valid) throw new Error('Bad MAC — wrong recovery key?');

  // Decrypt
  const aesKeyObj = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CTR' }, false, ['decrypt']);
  const plaintext = Buffer.from(await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv, length: 64 }, aesKeyObj, ciphertext
  ));
  return plaintext.toString('utf8');
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
  const targetDeviceId = process.argv[2]; // optional
  const token = getToken();

  // Load device info
  const deviceInfo = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'));
  const userId = deviceInfo.user_id;
  const selfSigningPub = deviceInfo.cross_signing.self_signing_key;
  const selfSigningKeyId = `ed25519:${selfSigningPub}`;
  const recoveryKeyEncoded = deviceInfo.recovery.recovery_key;
  const ssssKeyId = deviceInfo.recovery.key_id;

  console.log('User:', userId);
  console.log('Self-signing key:', selfSigningPub.slice(0, 20) + '...');

  // Decode recovery key
  const decoded = base58Decode(recoveryKeyEncoded);
  if (decoded[0] !== 0x8B || decoded[1] !== 0x01) {
    console.error('Invalid recovery key prefix!');
    process.exit(1);
  }
  const rawKey = decoded.slice(2, 34);

  // Fetch self-signing private key from SSSS
  console.log('\nFetching self-signing key from SSSS...');
  const ssssRes = await matrixApi(token, 'GET',
    `/user/${encodeURIComponent(userId)}/account_data/m.cross_signing.self_signing`);

  if (ssssRes.status !== 200) {
    console.error('Failed to fetch SSSS data:', ssssRes.status);
    process.exit(1);
  }

  const encryptedData = ssssRes.data.encrypted?.[ssssKeyId];
  if (!encryptedData) {
    console.error('No encrypted data for key ID:', ssssKeyId);
    process.exit(1);
  }

  const privKeyBase64 = await decryptSecret(encryptedData, rawKey, 'm.cross_signing.self_signing');
  console.log('Decrypted self-signing private key.');

  // Reconstruct the private key object
  const privKeyBytes = Buffer.from(privKeyBase64, 'base64');
  // Build PKCS8 DER for ed25519: fixed prefix + 32-byte seed
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der = Buffer.concat([pkcs8Prefix, privKeyBytes]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

  // Get all device keys
  const allDeviceIds = targetDeviceId ? [targetDeviceId] : undefined;
  const keysRes = await matrixApi(token, 'POST', '/keys/query', {
    device_keys: { [userId]: allDeviceIds || [] }
  });
  const allDevKeys = keysRes.data.device_keys?.[userId] || {};

  // Find devices that need signing
  const toSign = {};
  for (const [devId, devKeys] of Object.entries(allDevKeys)) {
    if (devId === deviceInfo.device.id) continue; // skip our own bot device (already signed)
    const existingSigs = Object.keys(devKeys.signatures?.[userId] || {});
    const alreadySigned = existingSigs.some(s => s === selfSigningKeyId);

    if (targetDeviceId && devId !== targetDeviceId) continue;

    if (alreadySigned) {
      console.log(`\n${devId}: already cross-signed, skipping.`);
      continue;
    }

    console.log(`\n${devId}: signing...`);
    const deviceToSign = {
      user_id: userId, device_id: devId,
      algorithms: devKeys.algorithms, keys: devKeys.keys,
    };
    const sig = signJson(deviceToSign, selfSigningKeyId, privateKey);

    toSign[devId] = {
      user_id: userId, device_id: devId,
      algorithms: devKeys.algorithms, keys: devKeys.keys,
      signatures: {
        [userId]: {
          ...devKeys.signatures?.[userId],
          [selfSigningKeyId]: sig,
        }
      }
    };
  }

  if (Object.keys(toSign).length === 0) {
    console.log('\nNo devices need signing.');
    return;
  }

  // Upload signatures
  const sigUpload = { [userId]: toSign };
  const res = await matrixApi(token, 'POST', '/keys/signatures/upload', sigUpload);
  console.log('\nSignature upload:', res.status);

  if (res.data.failures && Object.keys(res.data.failures).length > 0) {
    console.log('Failures:', JSON.stringify(res.data.failures, null, 2));
  }

  // Verify
  console.log('\n=== Result ===');
  const verifyRes = await matrixApi(token, 'POST', '/keys/query', {
    device_keys: { [userId]: [] }
  });
  for (const [devId, devKeys] of Object.entries(verifyRes.data.device_keys?.[userId] || {})) {
    const sigs = Object.keys(devKeys.signatures?.[userId] || {});
    const signed = sigs.some(s => s === selfSigningKeyId);
    console.log(`  ${devId}: ${signed ? 'VERIFIED' : 'not signed'} (${sigs.length} sigs)`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
