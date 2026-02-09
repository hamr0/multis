#!/usr/bin/env node
/**
 * Quick test of Beeper Desktop API (localhost:23373).
 * Uses OAuth PKCE to get a token, then lists accounts, chats, messages.
 *
 * First run: opens browser for OAuth approval, saves token.
 * Subsequent runs: reuses saved token.
 */
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = 'http://localhost:23373';
const TOKEN_FILE = path.join(__dirname, '..', '.beeper-storage', 'desktop-token.json');

async function api(token, method, apiPath, body) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${apiPath}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

function loadToken() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return data.access_token;
  } catch {
    return null;
  }
}

function saveToken(tokenData) {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
}

async function oauthPKCE() {
  // 1. Dynamic client registration
  const regRes = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'multis-test',
      redirect_uris: ['http://127.0.0.1:9876/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = await regRes.json();
  const clientId = client.client_id;
  console.log('  Registered client:', clientId);

  // 2. PKCE challenge
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  // 3. Start local callback server
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

      // 4. Exchange code for token
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

async function main() {
  console.log('=== Beeper Desktop API Test ===\n');

  // Check if Desktop is running
  try {
    await fetch(`${BASE}/v1/spec`, { signal: AbortSignal.timeout(2000) });
  } catch {
    console.error('Beeper Desktop not reachable at localhost:23373');
    process.exit(1);
  }

  // Get token (saved or OAuth)
  let token = loadToken();
  if (token) {
    // Verify token still works
    try {
      await api(token, 'GET', '/v1/accounts');
      console.log('[1] Using saved token\n');
    } catch {
      console.log('[1] Saved token expired, re-authenticating...');
      token = null;
    }
  }
  if (!token) {
    console.log('[1] OAuth PKCE authentication...');
    token = await oauthPKCE();
    console.log('  Authenticated!\n');
  }

  // 2. List accounts
  console.log('[2] Accounts:');
  const accounts = await api(token, 'GET', '/v1/accounts');
  const accountList = Array.isArray(accounts) ? accounts : accounts.items || [];
  for (const acc of accountList) {
    console.log(`  ${acc.network || '?'} (${acc.accountID}): ${acc.user?.displayText || acc.user?.id || '?'}`);
  }
  console.log();

  // 3. List recent chats
  console.log('[3] Recent chats:');
  const chats = await api(token, 'GET', '/v1/chats?limit=10');
  const chatList = chats.items || [];
  for (const chat of chatList) {
    const name = chat.title || chat.id;
    const net = chat.network || chat.accountID || '';
    const preview = chat.preview?.text || '';
    console.log(`  [${net}] ${name}`);
    if (preview) console.log(`    Last: ${preview.slice(0, 80)}`);
  }
  console.log();

  // 4. Search messages
  const query = process.argv[2] || 'hello';
  console.log(`[4] Message search for "${query}":`);
  try {
    const msgs = await api(token, 'GET', `/v1/messages/search?query=${encodeURIComponent(query)}&limit=5`);
    const msgList = msgs.items || [];
    for (const msg of msgList) {
      const sender = msg.senderName || msg.senderID || '?';
      const text = msg.text || '';
      const chatId = msg.chatID || '';
      console.log(`  [${chatId.slice(0, 20)}] ${sender}: ${text.slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`  Search error: ${e.message}`);
  }
  console.log();

  // 5. Pick first chat and list messages
  if (Array.isArray(chatList) && chatList.length > 0) {
    const firstChat = chatList[0];
    const chatId = firstChat.id || firstChat.chatID;
    const chatName = firstChat.name || firstChat.title || chatId;
    console.log(`[5] Recent messages in "${chatName}":`);
    try {
      const messages = await api(token, 'GET', `/v1/chats/${encodeURIComponent(chatId)}/messages?limit=5`);
      const list = messages.items || [];
      for (const msg of list) {
        const sender = msg.senderName || msg.senderID || '?';
        const text = msg.text || '';
        console.log(`  ${sender}: ${text.slice(0, 100)}`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
