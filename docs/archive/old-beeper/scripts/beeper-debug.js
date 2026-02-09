#!/usr/bin/env node
/**
 * Debug script - raw event logging from Beeper/Matrix.
 * Logs ALL events to find why messages aren't being captured.
 */

const {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin
} = require('matrix-bot-sdk');
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');

const HOMESERVER = 'https://matrix.beeper.com';

function getToken() {
  const output = execSync('pass multis/beeper_token', { encoding: 'utf8', timeout: 5000 });
  return output.split('\n')[0].trim();
}

async function main() {
  const token = getToken();
  console.log('Token loaded.');

  // Use fresh storage each time to avoid stale sync state
  const storageDir = path.join(__dirname, '..', '.beeper-storage');
  if (fs.existsSync(storageDir)) {
    fs.rmSync(storageDir, { recursive: true });
  }
  fs.mkdirSync(storageDir, { recursive: true });
  const storage = new SimpleFsStorageProvider(path.join(storageDir, 'bot.json'));

  const client = new MatrixClient(HOMESERVER, token, storage);

  const userId = await client.getUserId();
  console.log('Connected as:', userId);

  // Log ALL room events (not just messages)
  client.on('room.event', (roomId, event) => {
    console.log(`[EVENT] room=${roomId} type=${event.type} sender=${event.sender}`);
    if (event.content && event.content.body) {
      console.log(`  body: ${event.content.body}`);
    }
  });

  // Also try room.message specifically
  client.on('room.message', (roomId, event) => {
    console.log(`[MESSAGE] room=${roomId} sender=${event.sender} body=${event.content?.body}`);
  });

  // Log sync status
  client.on('sync', (state) => {
    console.log(`[SYNC] state=${state}`);
  });

  console.log('\nStarting sync... (will log ALL events for 60 seconds)');
  console.log('Send a message now.\n');

  await client.start();

  setTimeout(() => {
    console.log('\nDone.');
    client.stop();
    process.exit(0);
  }, 60000);
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
