#!/usr/bin/env node
/**
 * Save backup decryption key to crypto store so SDK can decrypt backed up sessions.
 * Then run a validate to test decryption.
 */
const crypto = require('crypto');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const HOMESERVER = 'https://matrix.beeper.com';
const RECOVERY_KEY = process.argv[2] || 'EsTy KVxw z6wo jwQV uegn yzUk ecca cngY BgnR b93y iGLT ZQRo';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = BASE58.indexOf(c); if (i >= 0) n = n * 58n + BigInt(i); }
  return Buffer.from(n.toString(16).padStart(70, '0'), 'hex');
}

async function api(token, endpoint) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
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

  console.log('=== Save Backup Key + Validate ===\n');

  // Decode recovery key → raw SSSS key
  const decoded = b58decode(RECOVERY_KEY);
  const rawKey = decoded.slice(2, 34);

  // Get SSSS default key ID
  const defaultKey = await api(token, `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`);
  const ssssKeyId = defaultKey?.key;

  // Decrypt backup key from SSSS
  const backupKeyData = await api(token, `/user/${encodeURIComponent(userId)}/account_data/m.megolm_backup.v1`);
  const encBackupKey = backupKeyData?.encrypted?.[ssssKeyId];
  const backupKeyBytes = await decryptSecret(encBackupKey, rawKey, 'm.megolm_backup.v1');
  console.log('[1] Backup decryption key:', backupKeyBytes.toString('base64'));

  // Get backup version info
  const backupInfo = await api(token, '/room_keys/version');
  console.log('[2] Backup version:', backupInfo?.version, 'sessions:', backupInfo?.count);

  // Start client and save key
  const { MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider } = require('matrix-bot-sdk');
  const storageDir = path.join(__dirname, '..', '.beeper-storage');
  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
  const storage = new SimpleFsStorageProvider(path.join(storageDir, 'bot.json'));
  const cryptoDir = path.join(storageDir, 'crypto');
  const cryptoProvider = new RustSdkCryptoStorageProvider(cryptoDir);
  const client = new MatrixClient(HOMESERVER, token, storage, cryptoProvider);

  // Suppress the room members crash
  process.on('uncaughtException', (err) => {
    if (err.message?.includes("Cannot read properties of null (reading 'map')")) return;
    console.error('Uncaught:', err.message);
  });

  await client.start({ syncTimeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 5000));

  const machine = client.crypto?.engine?.machine;
  if (!machine) {
    console.error('No crypto machine!');
    process.exit(1);
  }

  // Save the backup decryption key
  console.log('\n[3] Saving backup decryption key to crypto store...');
  try {
    await machine.saveBackupDecryptionKey(backupKeyBytes, backupInfo.version);
    console.log('  Saved!');
  } catch (e) {
    console.log('  Error:', e.message);
    // Try base64 format
    try {
      await machine.saveBackupDecryptionKey(backupKeyBytes.toString('base64'), backupInfo.version);
      console.log('  Saved (base64)!');
    } catch (e2) {
      console.log('  Error (base64):', e2.message);
    }
  }

  // Check backup status
  const enabled = await machine.isBackupEnabled();
  console.log('  Backup enabled:', enabled);

  // Try to get backup keys
  console.log('\n[4] Attempting to fetch backup keys...');
  try {
    const keys = await machine.getBackupKeys();
    console.log('  Got keys:', keys);
  } catch (e) {
    console.log('  getBackupKeys:', e.message);
  }

  // Verify backup
  try {
    const verified = await machine.verifyBackup(JSON.stringify(backupInfo));
    console.log('  Backup verified:', verified);
  } catch (e) {
    console.log('  verifyBackup:', e.message);
  }

  // Check room key counts
  try {
    const counts = await machine.roomKeyCounts();
    console.log('  Room key counts:', JSON.stringify(counts));
  } catch (e) {
    console.log('  roomKeyCounts:', e.message);
  }

  // Wait for key sync to propagate
  console.log('\n[5] Waiting 10s for key sync...');
  await new Promise(resolve => setTimeout(resolve, 10000));

  // Listen for messages
  console.log('\n[6] Listening for messages (60s)...');
  let msgCount = 0;
  let failCount = 0;

  client.on('room.message', async (roomId, event) => {
    if (!event.content?.body) return;
    msgCount++;
    const sender = event.sender;
    const self = sender === userId;
    console.log(`  [MSG] ${self ? '(self)' : sender}: ${event.content.body.slice(0, 80)}`);
  });

  client.on('room.failed_decryption', () => { failCount++; });

  await new Promise(resolve => setTimeout(resolve, 60000));

  console.log(`\nResults: ${msgCount} decrypted, ${failCount} failed`);
  client.stop();
  setTimeout(() => process.exit(0), 1000);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
