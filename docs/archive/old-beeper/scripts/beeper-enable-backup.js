#!/usr/bin/env node
/**
 * Enable backup and download keys, then validate message decryption.
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

async function api(token, method, endpoint, body) {
  const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3${endpoint}`, opts);
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

  // Get backup key from SSSS
  const decoded = b58decode(RECOVERY_KEY);
  const rawKey = decoded.slice(2, 34);
  const defaultKey = await api(token, 'GET', `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`);
  const ssssKeyId = defaultKey?.key;
  const backupKeyData = await api(token, 'GET', `/user/${encodeURIComponent(userId)}/account_data/m.megolm_backup.v1`);
  const backupKeyBuf = await decryptSecret(backupKeyData?.encrypted?.[ssssKeyId], rawKey, 'm.megolm_backup.v1');
  const backupKeyB64 = backupKeyBuf.toString('utf8').trim();

  const { BackupDecryptionKey } = require('@matrix-org/matrix-sdk-crypto-nodejs');
  const decryptionKey = BackupDecryptionKey.fromBase64(backupKeyB64);

  const backupInfo = await api(token, 'GET', '/room_keys/version');
  console.log('Backup version:', backupInfo?.version, '| sessions:', backupInfo?.count);
  console.log('Public keys match:', decryptionKey.megolmV1PublicKey.publicKeyBase64 === backupInfo?.auth_data?.public_key);

  // Start client
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

  // Save key
  console.log('\n[1] Saving backup key...');
  await machine.saveBackupDecryptionKey(decryptionKey, backupInfo.version);
  console.log('  Saved');

  // Try enableBackupV1
  console.log('\n[2] Enabling backup...');
  try {
    const pubKey = decryptionKey.megolmV1PublicKey;
    await machine.enableBackupV1(pubKey, backupInfo.version);
    console.log('  Backup v1 enabled!');
  } catch (e) {
    console.log('  enableBackupV1:', e.message);
  }

  console.log('  isBackupEnabled:', await machine.isBackupEnabled());
  console.log('  roomKeyCounts:', JSON.stringify(await machine.roomKeyCounts()));

  // Try to manually download and import keys
  console.log('\n[3] Manually downloading backed up keys...');
  const allKeys = await api(token, 'GET', '/room_keys/keys?version=' + backupInfo.version);
  const rooms = allKeys?.rooms || {};
  let imported = 0;
  let failed = 0;

  for (const [roomId, roomData] of Object.entries(rooms)) {
    for (const [sessionId, sessionData] of Object.entries(roomData.sessions || {})) {
      try {
        const data = sessionData.session_data;
        // Try to decrypt using the BackupDecryptionKey
        const decrypted = decryptionKey.decryptV1(
          data.ephemeral,
          data.mac,
          data.ciphertext
        );
        imported++;
        if (imported <= 3) {
          console.log(`  Decrypted session ${sessionId.slice(0, 15)}... in ${roomId.slice(0, 25)}...`);
          console.log('    Result type:', typeof decrypted, 'length:', decrypted?.length || '?');
        }
      } catch (e) {
        failed++;
        if (failed <= 2) console.log(`  Failed: ${e.message}`);
      }
    }
  }
  console.log(`  Total: ${imported} decrypted, ${failed} failed`);

  // If we got decrypted sessions, try to import them
  if (imported > 0) {
    console.log('\n[4] Importing decrypted sessions into crypto store...');
    try {
      // Try exportRoomKeysForSession to see format
      const exportMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(machine))
        .filter(m => m.includes('import') || m.includes('Import') || m.includes('room') || m.includes('Room'));
      console.log('  Available methods:', exportMethods.join(', '));
    } catch (e) {
      console.log('  Error:', e.message);
    }
  }

  // Wait for any automatic key sync
  console.log('\n[5] Waiting 10s...');
  await new Promise(resolve => setTimeout(resolve, 10000));
  console.log('  roomKeyCounts:', JSON.stringify(await machine.roomKeyCounts()));

  client.stop();
  console.log('\nDone.');
  setTimeout(() => process.exit(0), 1000);
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
