const m = require('@matrix-org/matrix-sdk-crypto-nodejs');

console.log('=== All exports ===');
const keys = Object.keys(m).sort();
for (const k of keys) console.log(' ', k, typeof m[k]);

// Check OlmMachine which is the main crypto engine
if (m.OlmMachine) {
  console.log('\n=== OlmMachine static methods ===');
  for (const k of Object.getOwnPropertyNames(m.OlmMachine)) {
    if (k !== 'length' && k !== 'name' && k !== 'prototype')
      console.log('  static', k);
  }
  console.log('\n=== OlmMachine instance methods ===');
  const proto = Object.getOwnPropertyNames(m.OlmMachine.prototype).filter(k => k !== 'constructor').sort();
  for (const k of proto) console.log(' ', k);
}
