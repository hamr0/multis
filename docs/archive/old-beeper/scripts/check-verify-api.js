const sdk = require('matrix-bot-sdk');

console.log('=== CryptoClient methods ===');
const methods = Object.getOwnPropertyNames(sdk.CryptoClient.prototype).filter(m => m !== 'constructor');
methods.sort();
for (const m of methods) console.log('  ', m);

console.log('\n=== SDK exports with verify/sas/cross ===');
for (const key of Object.keys(sdk)) {
  if (/verif|sas|cross/i.test(key)) console.log('  ', key);
}

console.log('\n=== RustSdkCryptoStorageProvider methods ===');
const rMethods = Object.getOwnPropertyNames(sdk.RustSdkCryptoStorageProvider.prototype).filter(m => m !== 'constructor');
rMethods.sort();
for (const m of rMethods) console.log('  ', m);
