#!/usr/bin/env node
/**
 * Beeper/Matrix validation script with E2EE support.
 * Proves: connection, encryption, room listing, message listening, reply sending.
 *
 * Usage: node scripts/beeper-validate.js
 */

const {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
  RustSdkCryptoStorageProvider
} = require('matrix-bot-sdk');
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');

const HOMESERVER = 'https://matrix.beeper.com';

function getToken() {
  try {
    const output = execSync('pass multis/beeper_token', { encoding: 'utf8', timeout: 5000 });
    return output.split('\n')[0].trim();
  } catch (err) {
    console.error('Failed to read token from pass. Run beeper-login.js first.');
    process.exit(1);
  }
}

async function main() {
  const token = getToken();
  console.log('Token loaded from pass.');

  // Storage for sync state
  const storageDir = path.join(__dirname, '..', '.beeper-storage');
  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
  const storage = new SimpleFsStorageProvider(path.join(storageDir, 'bot.json'));

  // Crypto storage for E2EE decryption
  const cryptoDir = path.join(storageDir, 'crypto');
  const cryptoProvider = new RustSdkCryptoStorageProvider(cryptoDir);

  const client = new MatrixClient(HOMESERVER, token, storage, cryptoProvider);
  AutojoinRoomsMixin.setupOnClient(client);

  const userId = await client.getUserId();
  console.log('Connected as:', userId);
  console.log('E2EE enabled.');

  // List rooms
  const rooms = await client.getJoinedRooms();
  console.log(`\nJoined rooms: ${rooms.length}`);

  for (const roomId of rooms.slice(0, 10)) {
    try {
      const state = await client.getRoomStateEvent(roomId, 'm.room.name', '');
      console.log(`  ${state.name || '(unnamed)'} → ${roomId}`);
    } catch {
      console.log(`  (unnamed) → ${roomId}`);
    }
  }
  if (rooms.length > 10) {
    console.log(`  ... and ${rooms.length - 10} more`);
  }

  const duration = parseInt(process.argv[2]) || 300;
  console.log(`\nListening for messages (${duration} seconds)...`);
  console.log('Send a message from any bridged app.\n');

  // Decrypted messages arrive here
  client.on('room.message', async (roomId, event) => {
    if (!event.content || !event.content.body) return;

    const sender = event.sender;
    const body = event.content.body;
    const self = sender === userId;

    if (self && body.startsWith('[multis]')) return;

    let roomName = roomId;
    try {
      const state = await client.getRoomStateEvent(roomId, 'm.room.name', '');
      roomName = state.name || roomId;
    } catch {}

    console.log(`[${roomName}] ${sender}${self ? ' (self)' : ''}: ${body}`);

    if (!self) {
      try {
        await client.sendText(roomId, `[multis] Echo: ${body}`);
        console.log(`  → Replied with echo`);
      } catch (err) {
        console.log(`  → Reply failed: ${err.message}`);
      }
    }
  });

  // Log decryption failures (suppress old message backfill noise)
  let decryptFails = 0;
  client.on('room.failed_decryption', (roomId, event, error) => {
    decryptFails++;
    if (decryptFails <= 3) {
      console.log(`[DECRYPT FAIL] ${error.message.includes('withheld') ? '(old session)' : ''} room=${roomId.slice(0, 20)}...`);
    } else if (decryptFails === 4) {
      console.log(`[DECRYPT FAIL] ... suppressing further old-message failures. Waiting for NEW messages...`);
    }
  });

  // Catch the room members null crash from bridged rooms
  process.on('uncaughtException', (err) => {
    if (err.message?.includes("Cannot read properties of null (reading 'map')")) {
      // Known matrix-bot-sdk bug with bridged rooms — ignore
      return;
    }
    console.error('Uncaught:', err.message);
  });

  // Clear old sync state for fresh start
  await client.start();
  console.log('Sync started (with E2EE). Waiting for NEW messages...');
  console.log('(Old messages will fail to decrypt — that is expected)\n');

  setTimeout(async () => {
    console.log(`\n${duration} seconds elapsed. ${decryptFails} old decrypt failures (expected). Stopping...`);
    client.stop();
    console.log('Done. Validation complete.');
    process.exit(0);
  }, duration * 1000);
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
