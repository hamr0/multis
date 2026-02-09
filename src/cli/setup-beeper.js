#!/usr/bin/env node
/**
 * Beeper Desktop API onboarding.
 *
 * Guides the user through:
 * 1. Installing Beeper Desktop and enabling the API
 * 2. OAuth PKCE authentication
 * 3. Verifying connected accounts
 * 4. Enabling Beeper in multis config
 *
 * Run: node src/cli/setup-beeper.js
 */
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const BASE = 'http://localhost:23373';
const MULTIS_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.multis');
const TOKEN_FILE = path.join(MULTIS_DIR, 'beeper-token.json');
const CONFIG_PATH = path.join(MULTIS_DIR, 'config.json');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function checkDesktop() {
  try {
    await fetch(`${BASE}/v1/spec`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

function loadToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveToken(tokenData) {
  if (!fs.existsSync(MULTIS_DIR)) fs.mkdirSync(MULTIS_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

async function api(token, method, apiPath) {
  const res = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

async function oauthPKCE() {
  // Dynamic client registration
  const regRes = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'multis',
      redirect_uris: ['http://127.0.0.1:9876/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = await regRes.json();
  const clientId = client.client_id;

  // PKCE
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/callback')) return;
      const url = new URL(req.url, 'http://127.0.0.1:9876');
      const code = url.searchParams.get('code');

      if (!code) {
        res.writeHead(400);
        res.end('No code received');
        server.close();
        reject(new Error('No auth code'));
        return;
      }

      const tokenRes = await fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: 'http://127.0.0.1:9876/callback',
          code_verifier: verifier,
        }),
      });
      const tokenData = await tokenRes.json();

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Authorized! You can close this tab.</h2>');
      server.close();

      saveToken(tokenData);
      resolve(tokenData.access_token);
    });

    server.listen(9876, '127.0.0.1', () => {
      const authUrl = `${BASE}/oauth/authorize?` + new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1:9876/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'read write',
      });
      console.log('  Opening browser for authorization...');
      try {
        execSync(`xdg-open "${authUrl}"`, { stdio: 'ignore' });
      } catch {
        console.log(`  Open manually: ${authUrl}`);
      }
    });

    setTimeout(() => { server.close(); reject(new Error('OAuth timeout (60s)')); }, 60000);
  });
}

function updateConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!config.platforms) config.platforms = {};
    if (!config.platforms.beeper) config.platforms.beeper = {};
    config.platforms.beeper.enabled = true;
    config.platforms.beeper.url = config.platforms.beeper.url || BASE;
    config.platforms.beeper.command_prefix = config.platforms.beeper.command_prefix || '//';
    config.platforms.beeper.poll_interval = config.platforms.beeper.poll_interval || 3000;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    return true;
  } catch (err) {
    console.error(`  Could not update config: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('=== multis: Beeper Desktop Setup ===\n');

  // Step 1: Instructions
  console.log('Prerequisites:');
  console.log('  1. Install Beeper Desktop from https://beeper.com');
  console.log('  2. Sign in and connect your accounts (WhatsApp, etc.)');
  console.log('  3. Enable Desktop API: Settings > Developers > toggle on');
  console.log();

  await prompt('Press Enter when ready...');

  // Step 2: Check Desktop is running
  console.log('\n[1] Checking Beeper Desktop API...');
  let reachable = await checkDesktop();

  if (!reachable) {
    console.log('  Not reachable at localhost:23373');
    console.log('  Make sure Beeper Desktop is open and the API is enabled.');
    await prompt('Press Enter to retry...');
    reachable = await checkDesktop();
    if (!reachable) {
      console.error('  Still not reachable. Aborting.');
      process.exit(1);
    }
  }
  console.log('  Desktop API is reachable.');

  // Step 3: OAuth (reuse saved token if valid)
  console.log('\n[2] Authentication...');
  let token = null;
  const saved = loadToken();
  if (saved?.access_token) {
    try {
      await api(saved.access_token, 'GET', '/v1/accounts');
      token = saved.access_token;
      console.log('  Using existing token.');
    } catch {
      console.log('  Saved token expired, re-authenticating...');
    }
  }

  if (!token) {
    console.log('  Starting OAuth PKCE flow...');
    token = await oauthPKCE();
    console.log('  Authenticated!');
  }

  // Step 4: List accounts
  console.log('\n[3] Connected accounts:');
  const accounts = await api(token, 'GET', '/v1/accounts');
  const list = Array.isArray(accounts) ? accounts : accounts.items || [];
  for (const acc of list) {
    const name = acc.user?.displayText || acc.user?.id || acc.accountID || '?';
    console.log(`  - ${acc.network || '?'}: ${name}`);
  }

  if (list.length === 0) {
    console.log('  No accounts found. Connect accounts in Beeper Desktop first.');
  }

  // Step 5: Update config
  console.log('\n[4] Updating multis config...');
  if (updateConfig()) {
    console.log('  Beeper enabled in ~/.multis/config.json');
  }

  // Done
  console.log('\n=== Setup complete! ===');
  console.log('Start multis with: node src/index.js');
  console.log(`Send ${list.length > 0 ? '//' : '//'}status from any Beeper chat to test.`);
  console.log('Only messages starting with // from your accounts will be processed.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
