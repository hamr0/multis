#!/usr/bin/env node
/**
 * Beeper login script - gets a Matrix access token via email code flow.
 *
 * Usage: node scripts/beeper-login.js your@email.com
 *
 * Flow:
 * 1. Initiates login with Beeper API
 * 2. Beeper sends a code to your email
 * 3. You enter the code
 * 4. Script exchanges it for a JWT, then a Matrix access token
 * 5. Saves token to pass store
 */

const https = require('https');
const readline = require('readline');

const BEEPER_API = 'https://api.beeper.com';
const MATRIX_API = 'https://matrix.beeper.com';
const AUTH_HEADER = 'Bearer BEEPER-PRIVATE-API-PLEASE-DONT-USE';

function request(url, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: body !== null ? 'POST' : 'GET',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

function matrixLogin(jwt) {
  return new Promise((resolve, reject) => {
    const url = new URL('/_matrix/client/v3/login', MATRIX_API);
    const body = JSON.stringify({ type: 'org.matrix.login.jwt', token: jwt });

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/beeper-login.js your@email.com');
    process.exit(1);
  }

  console.log('Step 1: Initiating login...');
  const step1 = await request(`${BEEPER_API}/user/login`, {});
  if (!step1.data.request) {
    console.error('Failed to initiate login:', step1.data);
    process.exit(1);
  }
  const requestToken = step1.data.request;
  console.log('Got request token.');

  console.log(`Step 2: Sending code to ${email}...`);
  const step2 = await request(`${BEEPER_API}/user/login/email`, {
    request: requestToken,
    email: email
  });
  console.log('Response:', step2.status, JSON.stringify(step2.data));

  const code = await ask('Enter the code from your email: ');

  console.log('Step 3: Exchanging code for JWT...');
  const step3 = await request(`${BEEPER_API}/user/login/response`, {
    request: requestToken,
    response: code
  });

  if (!step3.data.token) {
    console.error('Failed to get JWT:', step3.data);
    process.exit(1);
  }
  const jwt = step3.data.token;
  console.log('Got JWT.');

  console.log('Step 4: Matrix login...');
  const step4 = await matrixLogin(jwt);

  if (!step4.data.access_token) {
    console.error('Matrix login failed:', step4.data);
    process.exit(1);
  }

  console.log('\nSuccess!');
  console.log('User ID:', step4.data.user_id);
  console.log('Device ID:', step4.data.device_id);
  console.log('Access token:', step4.data.access_token.slice(0, 20) + '...');

  // Save to pass
  const save = await ask('\nSave access token to pass at multis/beeper_token? (y/n): ');
  if (save.toLowerCase() === 'y') {
    const { execSync } = require('child_process');
    const passData = `${step4.data.access_token}\nuser_id: ${step4.data.user_id}\ndevice_id: ${step4.data.device_id}\nhomeserver: ${MATRIX_API}`;
    try {
      execSync(`echo "${passData}" | pass insert -m multis/beeper_token`, { stdio: 'pipe' });
      console.log('Saved to pass at multis/beeper_token');
    } catch (err) {
      // pass entry might already exist
      execSync(`echo "${passData}" | pass insert -m -f multis/beeper_token`, { stdio: 'pipe' });
      console.log('Saved to pass at multis/beeper_token (overwritten)');
    }
  }

  console.log('\nAdd to .env:');
  console.log('BEEPER_ACCESS_TOKEN=pass:multis/beeper_token');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
