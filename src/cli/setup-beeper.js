#!/usr/bin/env node
/**
 * Beeper (via beeperbox) onboarding.
 *
 * multis is a pure MCP client — it talks to a beeperbox MCP endpoint, never the
 * raw Beeper Desktop API. So setup just needs the beeperbox MCP URL (+ token if
 * one is set) and a reachability check; the Beeper account/token lives inside
 * beeperbox (its own setup), not here.
 *
 * beeperbox runs three ways, same verbs: full Docker container, lite
 * (`node mcp/server.js` against a local Beeper Desktop), or remote. See
 * https://github.com/hamr0/beeperbox.
 *
 * NOTE: the legacy OAuth-PKCE-against-:23373 flow was retired with the MCP
 * migration (M-B step 3) — recoverable from git history if ever needed.
 *
 * Run: node src/cli/setup-beeper.js
 */
const fs = require('fs');
const readline = require('readline');
const { PATHS } = require('../config');
const { BeeperboxMcpClient } = require('../platforms/beeperbox-mcp');

const DEFAULT_MCP_URL = 'http://localhost:23375';
const CONFIG_PATH = PATHS.config();

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

/** Build the beeperbox MCP client for an endpoint. */
function makeClient({ url, token } = {}) {
  return new BeeperboxMcpClient({ url: url || DEFAULT_MCP_URL, token: token || null });
}

/**
 * Reachability + account list against beeperbox. Throws if unreachable
 * (caller decides retry/abort). Returns the normalized accounts array.
 */
async function listAccounts(client) {
  const accounts = await client.listAccounts();
  return Array.isArray(accounts) ? accounts : accounts?.items || [];
}

/** Human label for one beeperbox account record. */
function accountLabel(acc) {
  const net = acc.network_label || acc.network || '?';
  const name = acc.user?.display_name || acc.user?.id || acc.account_id || '?';
  return `${net}: ${name}`;
}

/**
 * Find the chat whose title matches a Telegram bot username, via the list_inbox
 * verb (so it works against a remote beeperbox too). Returns the chat id or null.
 */
async function findBotChat(client, botName) {
  if (!botName) return null;
  try {
    const chats = await client.callTool('list_inbox', { limit: 30 });
    const list = Array.isArray(chats) ? chats : chats?.items || [];
    const n = botName.replace('@', '').toLowerCase();
    const hit = list.find(c => {
      const t = (c.title || c.name || '').toLowerCase();
      return t === n || t === n.replace('bot', '');
    });
    return hit ? (hit.id || hit.chatID) : null;
  } catch {
    return null;
  }
}

function updateConfig({ mcpUrl, mcpToken } = {}) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!config.platforms) config.platforms = {};
    if (!config.platforms.beeper) config.platforms.beeper = {};
    const b = config.platforms.beeper;
    b.enabled = true;
    b.mcp_url = mcpUrl || b.mcp_url || DEFAULT_MCP_URL;
    if (mcpToken) b.mcp_token = mcpToken;
    b.command_prefix = b.command_prefix || '/';
    b.poll_interval = b.poll_interval || 3000;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    return true;
  } catch (err) {
    console.error(`  Could not update config: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('=== multis: Beeper (via beeperbox) Setup ===\n');

  console.log('Prerequisites — get beeperbox running first:');
  console.log('  - Docker container (headless Beeper inside), OR');
  console.log('  - lite mode: `node mcp/server.js` against your local Beeper Desktop, OR');
  console.log('  - a remote beeperbox you can reach.');
  console.log('  Sign into Beeper + enable its Developer API inside beeperbox.');
  console.log('  See https://github.com/hamr0/beeperbox');
  console.log();

  // Step 1: endpoint
  const urlInput = (await prompt(`beeperbox MCP URL [${DEFAULT_MCP_URL}]: `)).trim();
  const mcpUrl = urlInput || DEFAULT_MCP_URL;
  const mcpToken = (await prompt('MCP token (blank if none / loopback): ')).trim() || null;

  // Step 2: reachability + accounts
  console.log('\n[1] Checking beeperbox MCP...');
  const client = makeClient({ url: mcpUrl, token: mcpToken });
  let list;
  try {
    list = await listAccounts(client);
  } catch (err) {
    const hint = (err.code === 401 || err.code === 403)
      ? 'auth failed — check the MCP token'
      : 'unreachable — is beeperbox running at that URL?';
    console.error(`  ${hint}\n  ${err.message}`);
    await prompt('Press Enter to retry...');
    try {
      list = await listAccounts(client);
    } catch (err2) {
      console.error(`  Still failing (${err2.message}). Aborting.`);
      process.exit(1);
    }
  }
  console.log(`  Reachable. ${list.length} account(s).`);

  // Step 3: list accounts
  console.log('\n[2] Connected accounts:');
  for (const acc of list) console.log(`  - ${accountLabel(acc)}`);
  if (list.length === 0) {
    console.log('  None yet — connect accounts inside beeperbox (its noVNC login / your Beeper Desktop).');
  }

  // Step 4: write config
  console.log('\n[3] Updating multis config...');
  if (updateConfig({ mcpUrl, mcpToken })) {
    console.log('  Beeper enabled in ~/.multis/config.json');
  }

  console.log('\n=== Setup complete! ===');
  console.log('Start multis with: node src/index.js');
  console.log('Send /status from your Beeper Note-to-self chat to test.');
  console.log('Only / commands from your own account are processed.');
}

// Named exports for reuse in the init wizard (bin/multis.js)
module.exports = { makeClient, listAccounts, accountLabel, findBotChat, updateConfig, DEFAULT_MCP_URL };

// Run standalone if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
