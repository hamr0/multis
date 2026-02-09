#!/usr/bin/env node
/**
 * Test backup key import with patched RustEngine.js.
 * 1. Save backup decryption key into crypto store
 * 2. Enable backup so SDK requests backed-up sessions
 * 3. Listen for messages to verify decryption works
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
  const { aesKey } = await deriveKeys(rawKey, name);
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  const iv = Buffer.from(encrypted.iv, 'base64');
  const aesKeyObj = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CTR' }, false, ['decrypt']);
  return Buffer.from(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aesKeyObj, ciphertext));
}

async function main() {
  const token = execSync('pass multis/beeper_token', { encoding: 'utf8' }).split('\n')[0].trim();
  const userId = '@avoidaccess:beeper.com';

  console.log('=== Backup Key Import Test (patched RustEngine) ===\n');

  // 1. Get backup decryption key from SSSS
  const decoded = b58decode(RECOVERY_KEY);
  const rawKey = decoded.slice(2, 34);
  const defaultKey = await api(token, 'GET', `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`);
  const ssssKeyId = defaultKey?.key;
  const backupKeyData = await api(token, 'GET', `/user/${encodeURIComponent(userId)}/account_data/m.megolm_backup.v1`);
  const backupKeyBuf = await decryptSecret(backupKeyData?.encrypted?.[ssssKeyId], rawKey, 'm.megolm_backup.v1');
  const backupKeyB64 = backupKeyBuf.toString('utf8').trim();

  // 2. Create BackupDecryptionKey and verify against server
  const { BackupDecryptionKey } = require('@matrix-org/matrix-sdk-crypto-nodejs');
  const decryptionKey = BackupDecryptionKey.fromBase64(backupKeyB64);
  const backupInfo = await api(token, 'GET', '/room_keys/version');
  const keysMatch = decryptionKey.megolmV1PublicKey.publicKeyBase64 === backupInfo?.auth_data?.public_key;
  console.log(`[1] Backup version: ${backupInfo?.version} | sessions: ${backupInfo?.count} | keys match: ${keysMatch}`);

  if (!keysMatch) {
    console.error('Keys do not match! Aborting.');
    process.exit(1);
  }

  // 3. Start client with patched SDK
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
  console.log('[2] Client started, waiting for crypto init...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  const machine = client.crypto?.engine?.machine;
  if (!machine) { console.error('No crypto machine!'); process.exit(1); }

  // 4. Save backup key and enable backup
  console.log('[3] Saving backup decryption key...');
  await machine.saveBackupDecryptionKey(decryptionKey, backupInfo.version);
  console.log('    Saved.');

  console.log('[4] Enabling backup v1...');
  try {
    const pubKey = decryptionKey.megolmV1PublicKey;
    await machine.enableBackupV1(pubKey, backupInfo.version);
    console.log('    Enabled!');
  } catch (e) {
    console.log('    enableBackupV1:', e.message);
  }

  console.log('    isBackupEnabled:', await machine.isBackupEnabled());
  console.log('    roomKeyCounts:', JSON.stringify(await machine.roomKeyCounts()));

  // 5. Run outgoing requests — this triggers the patched KeysBackup handler
  console.log('\n[5] Processing outgoing requests (backup download)...');
  try {
    await client.crypto.engine.run();
    console.log('    Requests processed!');
  } catch (e) {
    console.log('    Error processing requests:', e.message);
  }

  console.log('    roomKeyCounts:', JSON.stringify(await machine.roomKeyCounts()));

  // 6. Wait for SDK to process backup keys
  console.log('\n[6] Waiting 15s for key import...');
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const counts = await machine.roomKeyCounts();
    console.log(`    ${(i + 1) * 5}s — roomKeyCounts: ${JSON.stringify(counts)}`);
    // Also trigger request processing
    try { await client.crypto.engine.run(); } catch {}
  }

  // 7. Listen for messages
  const duration = parseInt(process.argv[2]) || 120;
  console.log(`\n[7] Listening for messages (${duration}s)...`);
  console.log('    Send a message from any bridged app.\n');

  let decrypted = 0, failed = 0;

  client.on('room.message', async (roomId, event) => {
    if (!event.content?.body) return;
    decrypted++;
    const sender = event.sender;
    const self = sender === userId;
    let roomName = roomId;
    try {
      const state = await client.getRoomStateEvent(roomId, 'm.room.name', '');
      roomName = state.name || roomId;
    } catch {}
    console.log(`  [OK] [${roomName}] ${self ? '(self)' : sender}: ${event.content.body.slice(0, 100)}`);
  });

  client.on('room.failed_decryption', (roomId, event, error) => {
    failed++;
    if (failed <= 5) {
      const reason = error?.message?.slice(0, 80) || 'unknown';
      console.log(`  [FAIL] room=${roomId.slice(0, 25)}... ${reason}`);
    } else if (failed === 6) {
      console.log('  [FAIL] ... suppressing further failures');
    }
  });

  await new Promise(resolve => setTimeout(resolve, duration * 1000));

  console.log(`\n=== Results: ${decrypted} decrypted, ${failed} failed ===`);
  client.stop();
  setTimeout(() => process.exit(0), 1000);
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
