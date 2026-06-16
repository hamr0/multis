const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeper-test-'));
  const multisDir = path.join(dir, '.multis');
  fs.mkdirSync(multisDir, { recursive: true });
  for (const sub of ['data', 'auth', 'logs', 'run']) {
    fs.mkdirSync(path.join(multisDir, sub), { recursive: true });
  }
  return { dir, multisDir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makeConfig(overrides = {}) {
  return {
    platforms: {
      beeper: {
        enabled: true,
        url: 'http://localhost:23373',
        mcp_url: 'http://localhost:23375',
        command_prefix: '/',
        poll_interval: 100,
        ...overrides,
      },
    },
  };
}

// A normalized beeperbox message (the poll_messages / read_chat schema).
function bbMsg({ id, chat_id = 'c1', text = '', is_self = false, source = 'external', network = 'telegram', sender_name = '', timestamp = '2026-06-16T00:00:00.000Z' } = {}) {
  return {
    id: String(id),
    chat_id,
    network,
    network_label: network,
    sender: { id: is_self ? 'me' : 'other', name: sender_name, is_self },
    text,
    type: 'TEXT',
    timestamp,
    reply_to: null,
    source,
    client_tag: null,
  };
}

// Fake beeperbox MCP client. pollMessages drains a queue of responses (then
// empty/no-more). callTool('get_chat') serves chat metadata. Records sends.
function fakeMcp({ pollQueue = [], chats = {}, accounts = [{ network: 'telegram' }] } = {}) {
  const sends = [];
  let polls = 0;
  return {
    sends,
    polls: () => polls,
    async listAccounts() { return accounts; },
    async pollMessages() {
      polls++;
      if (pollQueue.length) return pollQueue.shift();
      return { cursor: 'cur-end', messages: [], has_more: false };
    },
    async sendMessage(args) { sends.push(args); return { message_id: 'sent', resolved: true, status: 'sent' }; },
    async noteToSelf(args) { sends.push({ ...args, noteToSelf: true }); return { message_id: 'sent', status: 'sent' }; },
    async callTool(name, args) {
      if (name === 'get_chat') {
        return chats[args.chat_id] || { id: args.chat_id, title: '', is_note_to_self: false, network: 'telegram' };
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

// ---------------------------------------------------------------------------
// BeeperPlatform unit tests
// ---------------------------------------------------------------------------

describe('BeeperPlatform', () => {
  let tmp, origHome;

  beforeEach(() => {
    tmp = tmpHome();
    origHome = process.env.HOME;
    process.env.HOME = tmp.dir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    tmp.cleanup();
  });

  // Fresh require each time because PATHS resolves process.env.HOME at call time
  // and we mutate HOME per test.
  function loadBeeper() {
    const modPath = require.resolve('../src/platforms/beeper');
    delete require.cache[modPath];
    return require(modPath);
  }

  // -------------------------------------------------------------------------
  // Constructor defaults
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('uses default URLs and poll interval when not configured', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform({ platforms: {} });
      assert.strictEqual(bp.baseUrl, 'http://localhost:23373');
      assert.strictEqual(bp.mcpUrl, 'http://localhost:23375');
      assert.strictEqual(bp.pollInterval, 3000);
      assert.strictEqual(bp.commandPrefix, '/');
    });

    it('respects custom config values', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig({
        url: 'http://localhost:9999',
        mcp_url: 'http://localhost:8888',
        poll_interval: 500,
        command_prefix: '!!',
      }));
      assert.strictEqual(bp.baseUrl, 'http://localhost:9999');
      assert.strictEqual(bp.mcpUrl, 'http://localhost:8888');
      assert.strictEqual(bp.pollInterval, 500);
      assert.strictEqual(bp.commandPrefix, '!!');
    });

    it('starts uninitialized with empty cursor and personal-chat set', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      assert.strictEqual(bp._initialized, false);
      assert.strictEqual(bp._cursor, null);
      assert.strictEqual(bp._personalChats.size, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Token loading (raw Desktop API token, for asset download)
  // -------------------------------------------------------------------------

  describe('_loadToken', () => {
    let savedEnvToken;
    beforeEach(() => { savedEnvToken = process.env.BEEPER_TOKEN; delete process.env.BEEPER_TOKEN; });
    afterEach(() => { if (savedEnvToken === undefined) delete process.env.BEEPER_TOKEN; else process.env.BEEPER_TOKEN = savedEnvToken; });

    it('prefers config platforms.beeper.token (swap-by-config for beeperbox)', () => {
      const { BeeperPlatform } = loadBeeper();
      fs.writeFileSync(path.join(tmp.multisDir, 'auth', 'beeper-token.json'), JSON.stringify({ access_token: 'file_tok' }));
      const bp = new BeeperPlatform(makeConfig({ token: 'cfg_tok' }));
      assert.strictEqual(bp._loadToken(), 'cfg_tok');
    });

    it('falls back to BEEPER_TOKEN env when no config token', () => {
      const { BeeperPlatform } = loadBeeper();
      process.env.BEEPER_TOKEN = 'env_tok';
      const bp = new BeeperPlatform(makeConfig());
      assert.strictEqual(bp._loadToken(), 'env_tok');
    });

    it('loads token from ~/.multis/auth/beeper-token.json', () => {
      const { BeeperPlatform } = loadBeeper();
      fs.writeFileSync(
        path.join(tmp.multisDir, 'auth', 'beeper-token.json'),
        JSON.stringify({ access_token: 'tok_123' })
      );
      const bp = new BeeperPlatform(makeConfig());
      assert.strictEqual(bp._loadToken(), 'tok_123');
    });

    it('returns null when no token file exists', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      assert.strictEqual(bp._loadToken(), null);
    });

    it('returns null for malformed token file', () => {
      const { BeeperPlatform } = loadBeeper();
      fs.writeFileSync(path.join(tmp.multisDir, 'auth', 'beeper-token.json'), 'not json');
      const bp = new BeeperPlatform(makeConfig());
      assert.strictEqual(bp._loadToken(), null);
    });
  });

  // -------------------------------------------------------------------------
  // mcp_token resolution
  // -------------------------------------------------------------------------

  describe('mcpToken', () => {
    let saved;
    beforeEach(() => { saved = process.env.MCP_AUTH_TOKEN; delete process.env.MCP_AUTH_TOKEN; });
    afterEach(() => { if (saved === undefined) delete process.env.MCP_AUTH_TOKEN; else process.env.MCP_AUTH_TOKEN = saved; });

    it('prefers config mcp_token, then env, else null', () => {
      const { BeeperPlatform } = loadBeeper();
      assert.strictEqual(new BeeperPlatform(makeConfig({ mcp_token: 'cfg' })).mcpToken, 'cfg');
      process.env.MCP_AUTH_TOKEN = 'env';
      assert.strictEqual(new BeeperPlatform(makeConfig()).mcpToken, 'env');
      delete process.env.MCP_AUTH_TOKEN;
      assert.strictEqual(new BeeperPlatform(makeConfig()).mcpToken, null);
    });
  });

  // -------------------------------------------------------------------------
  // Chat mode
  // -------------------------------------------------------------------------

  describe('_getChatMode', () => {
    it('returns silent by default when bot_mode is personal', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      assert.strictEqual(bp._getChatMode('chat1'), 'silent');
    });

    it('returns personal for self-chats (admin command channel)', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp._personalChats.add('selfChat');
      assert.strictEqual(bp._getChatMode('selfChat'), 'personal');
    });

    it('uses default_mode from config', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig({ default_mode: 'business' }));
      assert.strictEqual(bp._getChatMode('chat1'), 'business');
    });

    it('uses per-chat mode override', () => {
      const { BeeperPlatform } = loadBeeper();
      const cfg = makeConfig({ default_mode: 'off' });
      cfg.chats = { 'chat_biz': { mode: 'business' } };
      const bp = new BeeperPlatform(cfg);
      assert.strictEqual(bp._getChatMode('chat_biz'), 'business');
      assert.strictEqual(bp._getChatMode('chat_other'), 'off');
    });
  });

  // -------------------------------------------------------------------------
  // send() — beeperbox MCP, unique client_tag, no [multis] prefix
  // -------------------------------------------------------------------------

  describe('send', () => {
    it('sends via MCP sendMessage with a unique client_tag and no [multis] prefix', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp.mcp = fakeMcp();
      await bp.send('chat1', 'hello');
      await bp.send('chat1', 'hello'); // identical text, distinct tag
      assert.strictEqual(bp.mcp.sends.length, 2);
      assert.strictEqual(bp.mcp.sends[0].chat_id, 'chat1');
      assert.strictEqual(bp.mcp.sends[0].text, 'hello');
      assert.doesNotMatch(bp.mcp.sends[0].text, /\[multis\]/);
      assert.ok(bp.mcp.sends[0].client_tag, 'carries a client_tag');
      assert.notStrictEqual(bp.mcp.sends[0].client_tag, bp.mcp.sends[1].client_tag);
    });
  });

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  describe('start', () => {
    // beeper.js captures BeeperboxMcpClient via destructuring at require time,
    // so the fake must be installed on the (cached) module BEFORE loadBeeper()
    // re-requires beeper. withFakeClient does the patch/load/restore dance.
    function withFakeClient(FakeClass, fn) {
      const mcpMod = require('../src/platforms/beeperbox-mcp');
      const restore = mcpMod.BeeperboxMcpClient;
      mcpMod.BeeperboxMcpClient = FakeClass;
      try {
        const { BeeperPlatform } = loadBeeper();
        return fn(BeeperPlatform);
      } finally {
        mcpMod.BeeperboxMcpClient = restore;
      }
    }

    it('aborts when beeperbox MCP is unreachable', async () => {
      await withFakeClient(
        class { async listAccounts() { throw new Error('ECONNREFUSED'); } },
        async (BeeperPlatform) => {
          const bp = new BeeperPlatform(makeConfig());
          const ok = await bp.start();
          assert.strictEqual(ok, false);
          assert.strictEqual(bp._initialized, false);
          assert.strictEqual(bp._pollTimer, null);
        }
      );
    });

    it('seeds the cursor from now on first start and persists it', async () => {
      await withFakeClient(
        class {
          async listAccounts() { return [{ network: 'telegram' }]; }
          async pollMessages() { return { cursor: 'seed-cursor', messages: [], has_more: false, seeded: true }; }
        },
        async (BeeperPlatform) => {
          const bp = new BeeperPlatform(makeConfig());
          const ok = await bp.start();
          assert.strictEqual(ok, true);
          assert.strictEqual(bp._initialized, true);
          assert.strictEqual(bp._cursor, 'seed-cursor');
          const persisted = JSON.parse(fs.readFileSync(path.join(tmp.multisDir, 'run', 'beeper-cursor.json'), 'utf8'));
          assert.strictEqual(persisted.cursor, 'seed-cursor');
          await bp.stop();
        }
      );
    });

    it('still starts (with a warning) when beeperbox reports 0 accounts', async () => {
      await withFakeClient(
        class {
          async listAccounts() { return []; }
          async pollMessages() { return { cursor: 'seed', messages: [], has_more: false, seeded: true }; }
        },
        async (BeeperPlatform) => {
          const bp = new BeeperPlatform(makeConfig());
          const ok = await bp.start();
          assert.strictEqual(ok, true, 'reachable-but-empty is not a fatal error');
          assert.strictEqual(bp._initialized, true);
          await bp.stop();
        }
      );
    });

    it('aborts on an auth failure (401/403) from the MCP server', async () => {
      await withFakeClient(
        class { async listAccounts() { const e = new Error('Unauthorized'); e.code = 403; throw e; } },
        async (BeeperPlatform) => {
          const bp = new BeeperPlatform(makeConfig({ mcp_token: 'bad' }));
          const ok = await bp.start();
          assert.strictEqual(ok, false);
          assert.strictEqual(bp._initialized, false);
        }
      );
    });

    it('resumes a persisted cursor across restart (no re-seed)', async () => {
      fs.writeFileSync(path.join(tmp.multisDir, 'run', 'beeper-cursor.json'), JSON.stringify({ cursor: 'saved-cursor' }));
      let seeded = false;
      await withFakeClient(
        class {
          async listAccounts() { return []; }
          async pollMessages() { seeded = true; return { cursor: 'should-not-be-used', messages: [], has_more: false }; }
        },
        async (BeeperPlatform) => {
          const bp = new BeeperPlatform(makeConfig());
          await bp.start();
          assert.strictEqual(bp._cursor, 'saved-cursor', 'resumed from disk');
          assert.strictEqual(seeded, false, 'did not re-seed from now');
          await bp.stop();
        }
      );
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe('stop', () => {
    it('clears the poll timer', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp._pollTimer = setInterval(() => {}, 10000);
      await bp.stop();
      assert.strictEqual(bp._pollTimer, null);
    });
  });

  // -------------------------------------------------------------------------
  // _poll / _handleMessage — message routing
  // -------------------------------------------------------------------------

  describe('_poll', () => {
    function makeBp(loadBeeper, { pollQueue, chats } = {}) {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp._initialized = true;
      bp.mcp = fakeMcp({ pollQueue, chats });
      return bp;
    }

    function oneTick(messages, { has_more = false } = {}) {
      return [{ cursor: 'c1', messages, has_more }];
    }

    it('skips poll when not initialized', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp._initialized = false;
      bp.mcp = fakeMcp();
      await bp._poll();
      assert.strictEqual(bp.mcp.polls(), 0);
    });

    it('advances and persists the cursor each poll', async () => {
      const bp = makeBp(loadBeeper, { pollQueue: oneTick([]) });
      await bp._poll();
      assert.strictEqual(bp._cursor, 'c1');
      const persisted = JSON.parse(fs.readFileSync(path.join(tmp.multisDir, 'run', 'beeper-cursor.json'), 'utf8'));
      assert.strictEqual(persisted.cursor, 'c1');
    });

    it('routes self / command messages from personal chats', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: oneTick([bbMsg({ id: '10', text: '/status', is_self: true })]),
        chats: { c1: { title: 'My Notes', is_note_to_self: true } },
      });
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].text, '/status');
      assert.strictEqual(received[0].isSelf, true);
      assert.strictEqual(received[0].routeAs, null);
      assert.strictEqual(received[0].platform, 'beeper');
      assert.ok(bp._personalChats.has('c1'), 'note-to-self chat recorded as personal');
    });

    it('ignores / command from non-personal chat', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: oneTick([bbMsg({ id: '10', text: '/status', is_self: true })]),
        chats: { c1: { title: 'Friend Chat', is_note_to_self: false } },
      });
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      const commands = received.filter(m => m.routeAs === null);
      assert.strictEqual(commands.length, 0);
    });

    it('routes self natural language in personal chats', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: oneTick([bbMsg({ id: '10', text: 'what is the weather', is_self: true })]),
        chats: { c1: { title: 'Notes', is_note_to_self: true } },
      });
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].routeAs, 'natural');
    });

    it('routes non-self messages in business mode chats', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: oneTick([bbMsg({ id: '10', text: 'hi there', is_self: false })]),
        chats: { c1: { title: 'Customer', is_note_to_self: false } },
      });
      bp.config.chats = { c1: { mode: 'business' } };
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].routeAs, 'business');
      assert.strictEqual(received[0].isSelf, false);
    });

    it('archives non-self messages as silent in default mode', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: oneTick([bbMsg({ id: '10', text: 'hello', is_self: false })]),
        chats: { c1: { title: 'Acquaintance', is_note_to_self: false } },
      });
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].routeAs, 'silent');
    });

    it('skips source:"api" (our own sends) — echo-guard', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: oneTick([bbMsg({ id: '10', text: 'a bot reply', is_self: true, source: 'api' })]),
        chats: { c1: { title: 'Notes', is_note_to_self: true } },
      });
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      assert.strictEqual(received.length, 0);
    });

    it('skips chats whose title looks like a bot', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: oneTick([bbMsg({ id: '10', text: 'hi', is_self: false })]),
        chats: { c1: { title: 'SomeBot', is_note_to_self: false } },
      });
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      assert.strictEqual(received.length, 0);
    });

    it('excludes the configured Telegram bot chat', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig({ bot_chat_id: 'botchat' }));
      bp._initialized = true;
      bp.mcp = fakeMcp({ pollQueue: oneTick([bbMsg({ id: '10', chat_id: 'botchat', text: 'x', is_self: false })]) });
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      assert.strictEqual(received.length, 0);
    });

    it('drains has_more pages within one tick', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: [
          { cursor: 'p1', messages: [bbMsg({ id: '1', text: '/a', is_self: true })], has_more: true },
          { cursor: 'p2', messages: [bbMsg({ id: '2', text: '/b', is_self: true })], has_more: false },
        ],
        chats: { c1: { title: 'Notes', is_note_to_self: true } },
      });
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      assert.deepStrictEqual(received.map(m => m.text), ['/a', '/b']);
      assert.strictEqual(bp._cursor, 'p2');
    });

    it('caps the has_more drain at MAX_PAGES_PER_TICK', async () => {
      const bp = makeBp(loadBeeper);
      // Always has_more → infinite without the cap.
      bp.mcp.pollMessages = async () => ({ cursor: 'x', messages: [], has_more: true });
      let polls = 0;
      const inner = bp.mcp.pollMessages;
      bp.mcp.pollMessages = async (...a) => { polls++; return inner(...a); };
      await bp._poll();
      assert.strictEqual(polls, 10);
    });

    it('creates normalized Message with correct fields', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: oneTick([bbMsg({ id: '10', text: '/help', is_self: true, sender_name: 'Me', network: 'telegram' })]),
        chats: { c1: { title: 'Work Notes', is_note_to_self: true, network: 'telegram' } },
      });
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      const m = received[0];
      assert.strictEqual(m.id, '10');
      assert.strictEqual(m.platform, 'beeper');
      assert.strictEqual(m.chatId, 'c1');
      assert.strictEqual(m.chatName, 'Work Notes');
      assert.strictEqual(m.senderName, 'Me');
      assert.strictEqual(m.isSelf, true);
      assert.strictEqual(m.network, 'telegram');
    });

    it('caches chat metadata — get_chat called once per chat', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: [
          { cursor: 'a', messages: [bbMsg({ id: '1', text: '/a', is_self: true })], has_more: true },
          { cursor: 'b', messages: [bbMsg({ id: '2', text: '/b', is_self: true })], has_more: false },
        ],
        chats: { c1: { title: 'Notes', is_note_to_self: true } },
      });
      let getChatCalls = 0;
      const inner = bp.mcp.callTool;
      bp.mcp.callTool = async (name, args) => { if (name === 'get_chat') getChatCalls++; return inner(name, args); };
      bp.onMessage(async () => {});
      await bp._poll();
      assert.strictEqual(getChatCalls, 1, 'get_chat cached after first sighting');
    });

    it('handles handler errors without crashing the drain', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: oneTick([bbMsg({ id: '10', text: '/fail', is_self: true })]),
        chats: { c1: { title: 'Notes', is_note_to_self: true } },
      });
      bp.onMessage(async () => { throw new Error('handler boom'); });
      await bp._poll(); // should not throw
      assert.strictEqual(bp._cursor, 'c1', 'cursor still advanced past the failing message');
    });

    it('handles poll API errors gracefully', async () => {
      const bp = makeBp(loadBeeper);
      bp.mcp.pollMessages = async () => { throw new Error('network error'); };
      await bp._poll(); // should not throw
      assert.strictEqual(bp._pollErrorLogged, true);
    });

    it('logs poll error only once (suppresses repeated errors)', async () => {
      const bp = makeBp(loadBeeper);
      bp.mcp.pollMessages = async () => { throw new Error('network error'); };
      await bp._poll();
      assert.strictEqual(bp._pollErrorLogged, true);
      await bp._poll();
      assert.strictEqual(bp._pollErrorLogged, true);
    });

    it('clears poll error flag on success', async () => {
      const bp = makeBp(loadBeeper, { pollQueue: oneTick([]) });
      bp._pollErrorLogged = true;
      await bp._poll();
      assert.strictEqual(bp._pollErrorLogged, false);
    });

    it('off mode: skips non-self messages but allows self in personal chats', async () => {
      const bp = makeBp(loadBeeper, {
        pollQueue: oneTick([
          bbMsg({ id: '1', chat_id: 'cA', text: 'incoming', is_self: false }),
          bbMsg({ id: '2', chat_id: 'cB', text: '/cmd', is_self: true }),
        ]),
        chats: {
          cA: { title: 'Stranger', is_note_to_self: false },
          cB: { title: 'Notes', is_note_to_self: true },
        },
      });
      bp.config.platforms.beeper.default_mode = 'off';
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));
      await bp._poll();
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].chatId, 'cB');
    });
  });

  // -------------------------------------------------------------------------
  // listInbox — chat discovery via the list_inbox MCP verb (not raw :23373)
  // -------------------------------------------------------------------------

  describe('listInbox', () => {
    it('returns normalized chats from the list_inbox verb', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      let calledWith = null;
      bp.mcp = {
        async callTool(name, args) {
          calledWith = { name, args };
          return [{ id: 'c1', title: 'Alice', network: 'telegram', is_note_to_self: false }];
        },
      };
      const chats = await bp.listInbox(50);
      assert.strictEqual(calledWith.name, 'list_inbox');
      assert.strictEqual(calledWith.args.limit, 50);
      assert.strictEqual(chats[0].title, 'Alice');
    });

    it('unwraps an { items } envelope', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp.mcp = { async callTool() { return { items: [{ id: 'c2', title: 'Bob' }] }; } };
      const chats = await bp.listInbox();
      assert.strictEqual(chats[0].id, 'c2');
    });
  });

  // -------------------------------------------------------------------------
  // getAdminChatIds
  // -------------------------------------------------------------------------

  describe('getAdminChatIds', () => {
    it('returns the discovered personal chat ids', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp._personalChats.add('p1');
      bp._personalChats.add('p2');
      assert.deepStrictEqual(bp.getAdminChatIds().sort(), ['p1', 'p2']);
    });
  });
});

// ---------------------------------------------------------------------------
// Message class — Beeper-specific behavior
// ---------------------------------------------------------------------------

describe('Message (beeper)', () => {
  const { Message } = require('../src/platforms/message');

  it('isCommand returns true for self / messages', () => {
    const m = new Message({ platform: 'beeper', text: '/status', isSelf: true });
    assert.strictEqual(m.isCommand(), true);
  });

  it('isCommand returns false for non-self / messages', () => {
    const m = new Message({ platform: 'beeper', text: '/status', isSelf: false });
    assert.strictEqual(m.isCommand(), false);
  });

  it('isCommand returns false for self plain text', () => {
    const m = new Message({ platform: 'beeper', text: 'hello', isSelf: true });
    assert.strictEqual(m.isCommand(), false);
  });

  it('commandText strips / prefix and trims', () => {
    const m = new Message({ platform: 'beeper', text: '/exec ls', isSelf: true });
    assert.strictEqual(m.commandText(), 'exec ls');
  });

  it('commandText returns raw text for non-command', () => {
    const m = new Message({ platform: 'beeper', text: 'hello world', isSelf: true });
    assert.strictEqual(m.commandText(), 'hello world');
  });

  it('parseCommand extracts command and args', () => {
    const m = new Message({ platform: 'beeper', text: '/read /etc/hosts', isSelf: true });
    const parsed = m.parseCommand();
    assert.strictEqual(parsed.command, 'read');
    assert.strictEqual(parsed.args, '/etc/hosts');
  });

  it('parseCommand returns null for non-commands', () => {
    const m = new Message({ platform: 'beeper', text: 'just chatting', isSelf: false });
    assert.strictEqual(m.parseCommand(), null);
  });
});
