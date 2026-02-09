#!/usr/bin/env node
/**
 * Manually download backed-up Megolm sessions, decrypt them,
 * and import into the Rust crypto store — bypassing SDK backup flow.
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
  const { aesKey } = await deriveKeys(rawKey, name);
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  const iv = Buffer.from(encrypted.iv, 'base64');
  const aesKeyObj = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CTR' }, false, ['decrypt']);
  return Buffer.from(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aesKeyObj, ciphertext));
}

async function main() {
  const token = execSync('pass multis/beeper_token', { encoding: 'utf8' }).split('\n')[0].trim();
  const userId = '@avoidaccess:beeper.com';

  console.log('=== Manual Backup Import ===\n');

  // 1. Get backup decryption key
  const decoded = b58decode(RECOVERY_KEY);
  const rawKey = decoded.slice(2, 34);
  const defaultKey = await api(token, `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`);
  const ssssKeyId = defaultKey?.key;
  const backupKeyData = await api(token, `/user/${encodeURIComponent(userId)}/account_data/m.megolm_backup.v1`);
  const backupKeyBuf = await decryptSecret(backupKeyData?.encrypted?.[ssssKeyId], rawKey, 'm.megolm_backup.v1');
  const backupKeyB64 = backupKeyBuf.toString('utf8').trim();

  const { BackupDecryptionKey } = require('@matrix-org/matrix-sdk-crypto-nodejs');
  const decryptionKey = BackupDecryptionKey.fromBase64(backupKeyB64);
  const backupInfo = await api(token, '/room_keys/version');
  console.log(`[1] Backup: version=${backupInfo?.version}, sessions=${backupInfo?.count}`);

  // 2. Download all backed-up sessions
  const allKeys = await api(token, '/room_keys/keys?version=' + backupInfo.version);
  const rooms = allKeys?.rooms || {};

  // 3. Decrypt each session
  const exportedKeys = [];
  for (const [roomId, roomData] of Object.entries(rooms)) {
    for (const [sessionId, sessionData] of Object.entries(roomData.sessions || {})) {
      try {
        const data = sessionData.session_data;
        const decryptedJson = decryptionKey.decryptV1(data.ephemeral, data.mac, data.ciphertext);
        const session = JSON.parse(decryptedJson);
        // Build standard room key export format
        exportedKeys.push({
          algorithm: session.algorithm || 'm.megolm.v1.aes-sha2',
          room_id: roomId,
          sender_key: session.sender_key,
          session_id: sessionId,
          session_key: session.session_key,
          sender_claimed_keys: session.sender_claimed_keys || {},
          forwarding_curve25519_key_chain: session.forwarding_curve25519_key_chain || [],
        });
      } catch (e) {
        console.log(`  Failed to decrypt session ${sessionId.slice(0, 12)}...: ${e.message}`);
      }
    }
  }
  console.log(`[2] Decrypted ${exportedKeys.length} sessions from backup`);

  // 4. Start client and get OlmMachine
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
  console.log('[3] Client started, waiting for crypto...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  const machine = client.crypto?.engine?.machine;
  if (!machine) { console.error('No crypto machine!'); process.exit(1); }

  // 5. Explore import methods
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(machine));
  const importMethods = proto.filter(m =>
    m.toLowerCase().includes('import') ||
    m.toLowerCase().includes('roomkey') ||
    m.toLowerCase().includes('room_key')
  );
  console.log(`[4] Import-related methods: ${importMethods.join(', ') || 'NONE'}`);

  // Also check for any method that takes exported keys
  const allMethods = proto.filter(m => !m.startsWith('_'));
  console.log(`    All methods (${allMethods.length}): ${allMethods.join(', ')}`);

  // 6. Try import methods
  console.log('\n[5] Attempting import...');
  const keysJson = JSON.stringify(exportedKeys);

  // Try importRoomKeys
  if (typeof machine.importRoomKeys === 'function') {
    try {
      const result = await machine.importRoomKeys(keysJson, (progress, total) => {
        console.log(`    Progress: ${progress}/${total}`);
      });
      console.log('    importRoomKeys result:', result);
    } catch (e) {
      console.log('    importRoomKeys error:', e.message);
    }
  }

  // Try importDecryptedRoomKeys
  if (typeof machine.importDecryptedRoomKeys === 'function') {
    try {
      const result = await machine.importDecryptedRoomKeys(keysJson, (progress, total) => {
        console.log(`    Progress: ${progress}/${total}`);
      });
      console.log('    importDecryptedRoomKeys result:', result);
    } catch (e) {
      console.log('    importDecryptedRoomKeys error:', e.message);
    }
  }

  // Try importExportedRoomKeys
  if (typeof machine.importExportedRoomKeys === 'function') {
    try {
      const result = await machine.importExportedRoomKeys(keysJson, (progress, total) => {
        console.log(`    Progress: ${progress}/${total}`);
      });
      console.log('    importExportedRoomKeys result:', result);
    } catch (e) {
      console.log('    importExportedRoomKeys error:', e.message);
    }
  }

  // Check room key counts after import
  const counts = await machine.roomKeyCounts();
  console.log(`\n[6] Room key counts after import: ${JSON.stringify(counts)}`);

  // 7. Quick message test
  console.log('\n[7] Listening 60s for messages...');
  let ok = 0, fail = 0;
  client.on('room.message', async (roomId, event) => {
    if (!event.content?.body) return;
    ok++;
    let name = roomId;
    try { name = (await client.getRoomStateEvent(roomId, 'm.room.name', '')).name || roomId; } catch {}
    console.log(`  [OK] [${name}] ${event.sender}: ${event.content.body.slice(0, 100)}`);
  });
  client.on('room.failed_decryption', () => { fail++; });

  await new Promise(resolve => setTimeout(resolve, 60000));
  console.log(`\n=== ${ok} decrypted, ${fail} failed ===`);
  client.stop();
  setTimeout(() => process.exit(0), 1000);
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
