#!/usr/bin/env node
/**
 * Import backup decryption key into Rust SDK crypto store.
 * This lets the SDK automatically decrypt backed-up Megolm sessions.
 */
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const HOMESERVER = 'https://matrix.beeper.com';
const RECOVERY_KEY = 'EsTy KVxw z6wo jwQV uegn yzUk ecca cngY BgnR b93y iGLT ZQRo';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = BASE58.indexOf(c); if (i >= 0) n = n * 58n + BigInt(i); }
  return Buffer.from(n.toString(16).padStart(70, '0'), 'hex');
}

async function api(token, endpoint) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return res.json().catch(() => null);
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
  const aesKeyObj = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CTR' }, false, ['decrypt']);
  return Buffer.from(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aesKeyObj, ciphertext));
}

async function main() {
  const token = execSync('pass multis/beeper_token', { encoding: 'utf8' }).split('\n')[0].trim();
  const userId = '@avoidaccess:beeper.com';

  console.log('=== Import Backup Key ===\n');

  // 1. Decode recovery key
  const decoded = b58decode(RECOVERY_KEY);
  const rawKey = decoded.slice(2, 34);

  // 2. Get backup decryption key from SSSS
  const defaultKey = await api(token, `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`);
  const ssssKeyId = defaultKey?.key;
  const backupKeyData = await api(token, `/user/${encodeURIComponent(userId)}/account_data/m.megolm_backup.v1`);
  const encBackupKey = backupKeyData?.encrypted?.[ssssKeyId];
  const backupKeyBuf = await decryptSecret(encBackupKey, rawKey, 'm.megolm_backup.v1');

  // The SSSS stores the key as base64-encoded bytes, but we need raw base64
  // The decrypted value is the base64 string of the private key
  const backupKeyB64 = backupKeyBuf.toString('utf8').trim();
  console.log('Backup key (b64):', backupKeyB64.slice(0, 20) + '...');

  // 3. Create BackupDecryptionKey object
  const { BackupDecryptionKey } = require('@matrix-org/matrix-sdk-crypto-nodejs');
  const decryptionKey = BackupDecryptionKey.fromBase64(backupKeyB64);
  console.log('BackupDecryptionKey created');
  console.log('Public key:', decryptionKey.megolmV1PublicKey.publicKeyBase64);

  // Check against backup version
  const backupInfo = await api(token, '/room_keys/version');
  console.log('Backup public key:', backupInfo.auth_data?.public_key);
  console.log('Keys match:', decryptionKey.megolmV1PublicKey.publicKeyBase64 === backupInfo.auth_data?.public_key);

  // 4. Start SDK and save key
  const { MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider } = require('matrix-bot-sdk');
  const storageDir = path.join(__dirname, '..', '.beeper-storage');
  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
  const storage = new SimpleFsStorageProvider(path.join(storageDir, 'bot.json'));
  const cryptoDir = path.join(storageDir, 'crypto');
  const cryptoProvider = new RustSdkCryptoStorageProvider(cryptoDir);
  const client = new MatrixClient(HOMESERVER, token, storage, cryptoProvider);

  process.on('uncaughtException', (err) => {
    if (err.message?.includes("Cannot read properties of null (reading 'map')")) return;
    console.error('Uncaught:', err.message);
  });

  await client.start({ syncTimeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 5000));

  const machine = client.crypto?.engine?.machine;
  if (!machine) { console.error('No crypto!'); process.exit(1); }

  console.log('\nSaving backup decryption key...');
  await machine.saveBackupDecryptionKey(decryptionKey, backupInfo.version);
  console.log('Saved!');

  const enabled = await machine.isBackupEnabled();
  console.log('Backup enabled:', enabled);

  const counts = await machine.roomKeyCounts();
  console.log('Room key counts:', JSON.stringify(counts));

  // Wait for SDK to process
  console.log('\nWaiting 15s for key download...');
  await new Promise(resolve => setTimeout(resolve, 15000));

  const counts2 = await machine.roomKeyCounts();
  console.log('Room key counts after wait:', JSON.stringify(counts2));

  client.stop();
  console.log('\nDone. Run beeper-validate.js to test.');
  setTimeout(() => process.exit(0), 1000);
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
