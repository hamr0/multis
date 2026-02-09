#!/usr/bin/env node
const sdk = require('@matrix-org/matrix-sdk-crypto-nodejs');
const keys = Object.keys(sdk).filter(k =>
  k.toLowerCase().includes('backup') || k.toLowerCase().includes('decryption')
);
console.log('Backup-related exports:', keys);

for (const name of keys) {
  const obj = sdk[name];
  if (typeof obj === 'function') {
    console.log('\n' + name + ':');
    const proto = obj.prototype ? Object.getOwnPropertyNames(obj.prototype).filter(m => m !== 'constructor') : [];
    const statics = Object.getOwnPropertyNames(obj).filter(m => m !== 'length' && m !== 'name' && m !== 'prototype');
    if (statics.length) console.log('  static:', statics.join(', '));
    if (proto.length) console.log('  methods:', proto.join(', '));
  }
}

// Try to create a BackupDecryptionKey
if (sdk.BackupDecryptionKey) {
  console.log('\n=== BackupDecryptionKey ===');
  // Try base64 of 32 bytes
  const testKey = Buffer.alloc(32).toString('base64');
  try {
    const key = sdk.BackupDecryptionKey.fromBase64(testKey);
    console.log('fromBase64 works! type:', typeof key);
    console.log('  megolmV1PublicKey:', key.megolmV1PublicKey);
  } catch (e) {
    console.log('fromBase64 error:', e.message);
  }
}
