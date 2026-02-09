#!/usr/bin/env node
/**
 * Restore Megolm session keys from Beeper's key backup using recovery key.
 * This gives our bot device the keys to decrypt messages from bridges.
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

function getToken() {
  return execSync('pass multis/beeper_token', { encoding: 'utf8' }).split('\n')[0].trim();
}

async function api(token, method, endpoint, body) {
  const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3${endpoint}`, opts);
  return { status: res.status, data: await res.json().catch(() => null) };
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
  if (!valid) throw new Error('Bad MAC');
  const aesKeyObj = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-CTR' }, false, ['decrypt']);
  return Buffer.from(await crypto.subtle.decrypt({ name: 'AES-CTR', counter: iv, length: 64 }, aesKeyObj, ciphertext));
}

async function main() {
  const token = getToken();
  console.log('=== Restore Keys from Backup ===\n');

  // Decode recovery key
  const decoded = b58decode(RECOVERY_KEY);
  const rawKey = decoded.slice(2, 34);

  // Get SSSS key ID
  const userId = '@avoidaccess:beeper.com';
  const defaultKeyRes = await api(token, 'GET', `/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default_key`);
  const ssssKeyId = defaultKeyRes.data?.key;

  // Get backup decryption key from SSSS
  console.log('[1] Fetching backup key from SSSS...');
  const backupKeyRes = await api(token, 'GET', `/user/${encodeURIComponent(userId)}/account_data/m.megolm_backup.v1`);
  const encBackupKey = backupKeyRes.data?.encrypted?.[ssssKeyId];
  if (!encBackupKey) {
    console.error('No backup key in SSSS!');
    process.exit(1);
  }
  const backupKeyBytes = await decryptSecret(encBackupKey, rawKey, 'm.megolm_backup.v1');
  console.log('  Backup key decrypted:', backupKeyBytes.length, 'bytes');

  // Get all backed up keys
  console.log('\n[2] Fetching backed up sessions...');
  const allKeys = await api(token, 'GET', '/room_keys/keys?version=2');
  const rooms = allKeys.data?.rooms || {};
  let totalSessions = 0;
  let decrypted = 0;

  // The backup key is a curve25519 private key
  // Backup sessions are encrypted with ECDH using the backup public key
  // We need to decrypt each session

  // Import the private key for ECDH
  const backupPrivKey = backupKeyBytes;

  console.log('\n[3] Decrypting sessions...');
  for (const [roomId, roomData] of Object.entries(rooms)) {
    const sessions = roomData.sessions || {};
    for (const [sessionId, sessionData] of Object.entries(sessions)) {
      totalSessions++;
      const data = sessionData.session_data;

      // Each session is encrypted with:
      // ephemeral: curve25519 public key
      // ciphertext: encrypted with derived key
      // mac: HMAC
      try {
        const ephemeralKey = Buffer.from(data.ephemeral, 'base64');
        const ciphertext = Buffer.from(data.ciphertext, 'base64');
        const mac = Buffer.from(data.mac, 'base64');

        // ECDH: shared_secret = ECDH(backup_private, ephemeral)
        // Then HKDF to derive AES + HMAC keys
        // This uses curve25519 ECDH, same as Olm

        // For now, just count — actual import needs the Rust SDK
        decrypted++;
      } catch (e) {
        console.log(`  Failed: ${roomId.slice(0, 20)}... ${e.message}`);
      }
    }
  }

  console.log(`\n  Total sessions: ${totalSessions}`);
  console.log(`  Sessions available: ${decrypted}`);

  // The actual key import needs to happen through the matrix-bot-sdk crypto
  // Let's use the SDK to import from backup
  console.log('\n[4] Importing via matrix-bot-sdk...');

  const {
    MatrixClient, SimpleFsStorageProvider, RustSdkCryptoStorageProvider
  } = require('matrix-bot-sdk');

  const storageDir = path.join(__dirname, '..', '.beeper-storage');
  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
  const storage = new SimpleFsStorageProvider(path.join(storageDir, 'bot.json'));
  const cryptoDir = path.join(storageDir, 'crypto');
  const cryptoProvider = new RustSdkCryptoStorageProvider(cryptoDir);
  const client = new MatrixClient(HOMESERVER, token, storage, cryptoProvider);

  await client.start({ syncTimeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Check if the SDK has a method to restore from backup
  const cryptoEngine = client.crypto?.engine;
  if (cryptoEngine) {
    console.log('  Crypto engine available');
    const machine = cryptoEngine.machine;
    if (machine) {
      // List available methods
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(machine))
        .filter(m => m.toLowerCase().includes('backup') || m.toLowerCase().includes('key') || m.toLowerCase().includes('import'));
      console.log('  Backup-related methods:', methods.join(', '));
    }
  }

  client.stop();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
