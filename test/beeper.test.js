const { describe, it, beforeEach, afterEach, mock } = require('node:test');
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
  return { dir, multisDir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makeConfig(overrides = {}) {
  return {
    platforms: {
      beeper: {
        enabled: true,
        url: 'http://localhost:23373',
        command_prefix: '//',
        poll_interval: 100,
        ...overrides,
      },
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

  // We need a fresh require each time because TOKEN_FILE uses process.env.HOME at load time
  function loadBeeper() {
    const modPath = require.resolve('../src/platforms/beeper');
    delete require.cache[modPath];
    return require(modPath);
  }

  // -------------------------------------------------------------------------
  // Constructor defaults
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('uses default URL and poll interval when not configured', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform({ platforms: {} });
      assert.strictEqual(bp.baseUrl, 'http://localhost:23373');
      assert.strictEqual(bp.pollInterval, 3000);
      assert.strictEqual(bp.commandPrefix, '//');
    });

    it('respects custom config values', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig({
        url: 'http://localhost:9999',
        poll_interval: 500,
        command_prefix: '!!',
      }));
      assert.strictEqual(bp.baseUrl, 'http://localhost:9999');
      assert.strictEqual(bp.pollInterval, 500);
      assert.strictEqual(bp.commandPrefix, '!!');
    });

    it('initializes empty selfIds and lastSeen', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      assert.strictEqual(bp.selfIds.size, 0);
      assert.deepStrictEqual(bp._lastSeen, {});
      assert.strictEqual(bp._initialized, false);
    });
  });

  // -------------------------------------------------------------------------
  // Token loading
  // -------------------------------------------------------------------------

  describe('_loadToken', () => {
    it('loads token from ~/.multis/beeper-token.json', () => {
      const { BeeperPlatform } = loadBeeper();
      fs.writeFileSync(
        path.join(tmp.multisDir, 'beeper-token.json'),
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
      fs.writeFileSync(path.join(tmp.multisDir, 'beeper-token.json'), 'not json');
      const bp = new BeeperPlatform(makeConfig());
      assert.strictEqual(bp._loadToken(), null);
    });
  });

  // -------------------------------------------------------------------------
  // Self detection
  // -------------------------------------------------------------------------

  describe('_isSelf', () => {
    it('returns true when senderID is in selfIds', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp.selfIds.add('user_abc');
      assert.strictEqual(bp._isSelf({ senderID: 'user_abc' }), true);
    });

    it('returns false for unknown sender', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp.selfIds.add('user_abc');
      assert.strictEqual(bp._isSelf({ senderID: 'other' }), false);
    });

    it('falls back to sender field', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp.selfIds.add('user_x');
      assert.strictEqual(bp._isSelf({ sender: 'user_x' }), true);
    });
  });

  // -------------------------------------------------------------------------
  // Chat mode
  // -------------------------------------------------------------------------

  describe('_getChatMode', () => {
    it('returns personal by default', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      assert.strictEqual(bp._getChatMode('chat1'), 'personal');
    });

    it('uses default_mode from config', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig({ default_mode: 'business' }));
      assert.strictEqual(bp._getChatMode('chat1'), 'business');
    });

    it('uses per-chat mode override', () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig({
        default_mode: 'personal',
        chat_modes: { 'chat_biz': 'business' },
      }));
      assert.strictEqual(bp._getChatMode('chat_biz'), 'business');
      assert.strictEqual(bp._getChatMode('chat_other'), 'personal');
    });
  });

  // -------------------------------------------------------------------------
  // send() prefixes with [multis]
  // -------------------------------------------------------------------------

  describe('send', () => {
    it('prefixes response with [multis]', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      let captured;
      bp._api = async (method, apiPath, body) => { captured = { method, apiPath, body }; };
      await bp.send('chat1', 'hello');
      assert.strictEqual(captured.method, 'POST');
      assert.match(captured.apiPath, /chat1/);
      assert.strictEqual(captured.body.text, '[multis] hello');
    });
  });

  // -------------------------------------------------------------------------
  // start() — token missing
  // -------------------------------------------------------------------------

  describe('start', () => {
    it('aborts when no token is found', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      await bp.start();
      assert.strictEqual(bp._initialized, false);
      assert.strictEqual(bp._pollTimer, null);
    });

    it('aborts when API call fails', async () => {
      const { BeeperPlatform } = loadBeeper();
      fs.writeFileSync(
        path.join(tmp.multisDir, 'beeper-token.json'),
        JSON.stringify({ access_token: 'bad_tok' })
      );
      const bp = new BeeperPlatform(makeConfig());
      bp._api = async () => { throw new Error('401 Unauthorized'); };
      await bp.start();
      assert.strictEqual(bp._initialized, false);
    });

    it('populates selfIds from accounts response', async () => {
      const { BeeperPlatform } = loadBeeper();
      fs.writeFileSync(
        path.join(tmp.multisDir, 'beeper-token.json'),
        JSON.stringify({ access_token: 'good_tok' })
      );
      const bp = new BeeperPlatform(makeConfig());

      const apiCalls = [];
      bp._api = async (method, apiPath) => {
        apiCalls.push(apiPath);
        if (apiPath === '/v1/accounts') {
          return { items: [
            { user: { id: 'uid1' }, accountID: 'acc1' },
            { user: { id: 'uid2' }, accountID: 'acc2' },
          ]};
        }
        // _seedLastSeen chats
        if (apiPath.includes('/v1/chats')) return { items: [] };
        return {};
      };

      await bp.start();
      assert.ok(bp.selfIds.has('uid1'));
      assert.ok(bp.selfIds.has('acc1'));
      assert.ok(bp.selfIds.has('uid2'));
      assert.ok(bp.selfIds.has('acc2'));
      assert.strictEqual(bp._initialized, true);

      // Cleanup timer
      await bp.stop();
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
  // _seedLastSeen
  // -------------------------------------------------------------------------

  describe('_seedLastSeen', () => {
    it('seeds lastSeen from latest message IDs', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());

      bp._api = async (method, apiPath) => {
        if (apiPath.startsWith('/v1/chats?')) {
          return { items: [
            { id: 'chatA', type: 'group', participants: ['a', 'b'] },
            { id: 'chatB', type: 'single', participants: [] },
          ]};
        }
        if (apiPath.includes('chatA/messages')) {
          return { items: [{ id: '100' }] };
        }
        if (apiPath.includes('chatB/messages')) {
          return { items: [{ id: '200' }] };
        }
        return { items: [] };
      };

      await bp._seedLastSeen();
      assert.strictEqual(bp._lastSeen['chatA'], 100);
      assert.strictEqual(bp._lastSeen['chatB'], 200);
    });

    it('detects personal/self chats (single + <=1 participant)', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());

      bp._api = async (method, apiPath) => {
        if (apiPath.startsWith('/v1/chats?')) {
          return { items: [
            { id: 'selfChat', type: 'single', participants: [] },
            { id: 'groupChat', type: 'group', participants: ['a', 'b', 'c'] },
            { id: 'dmChat', type: 'single', participants: ['me'] },
          ]};
        }
        return { items: [{ id: '1' }] };
      };

      await bp._seedLastSeen();
      assert.ok(bp._personalChats.has('selfChat'));
      assert.ok(!bp._personalChats.has('groupChat'));
      assert.ok(bp._personalChats.has('dmChat'));
    });

    it('handles API errors gracefully', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp._api = async () => { throw new Error('network down'); };
      await bp._seedLastSeen(); // should not throw
      assert.deepStrictEqual(bp._lastSeen, {});
    });
  });

  // -------------------------------------------------------------------------
  // _poll — message routing
  // -------------------------------------------------------------------------

  describe('_poll', () => {
    function makeBp(loadBeeper) {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp._initialized = true;
      bp.selfIds.add('self1');
      return bp;
    }

    function fakeApi(chats, messagesByChat) {
      return async (method, apiPath) => {
        if (apiPath.startsWith('/v1/chats?')) return { items: chats };
        for (const [chatId, msgs] of Object.entries(messagesByChat)) {
          if (apiPath.includes(`${chatId}/messages`)) return { items: msgs };
        }
        return { items: [] };
      };
    }

    it('skips poll when not initialized', async () => {
      const { BeeperPlatform } = loadBeeper();
      const bp = new BeeperPlatform(makeConfig());
      bp._initialized = false;
      let called = false;
      bp._api = async () => { called = true; return { items: [] }; };
      await bp._poll();
      assert.strictEqual(called, false);
    });

    it('routes self // command messages', async () => {
      const bp = makeBp(loadBeeper);
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));

      bp._api = fakeApi(
        [{ id: 'c1', title: 'My Chat' }],
        { c1: [{ id: '10', senderID: 'self1', text: '//status' }] }
      );

      await bp._poll();
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].text, '//status');
      assert.strictEqual(received[0].isSelf, true);
      assert.strictEqual(received[0].routeAs, null);
      assert.strictEqual(received[0].platform, 'beeper');
    });

    it('routes self natural language in personal chats', async () => {
      const bp = makeBp(loadBeeper);
      bp._personalChats.add('c1');
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));

      bp._api = fakeApi(
        [{ id: 'c1' }],
        { c1: [{ id: '10', senderID: 'self1', text: 'what is the weather' }] }
      );

      await bp._poll();
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].routeAs, 'natural');
    });

    it('routes non-self messages in business mode chats', async () => {
      const bp = makeBp(loadBeeper);
      bp.config.platforms.beeper.chat_modes = { c1: 'business' };
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));

      bp._api = fakeApi(
        [{ id: 'c1' }],
        { c1: [{ id: '10', senderID: 'customer1', text: 'hi there' }] }
      );

      await bp._poll();
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0].routeAs, 'business');
      assert.strictEqual(received[0].isSelf, false);
    });

    it('ignores non-self messages in personal mode', async () => {
      const bp = makeBp(loadBeeper);
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));

      bp._api = fakeApi(
        [{ id: 'c1' }],
        { c1: [{ id: '10', senderID: 'other1', text: 'hello' }] }
      );

      await bp._poll();
      assert.strictEqual(received.length, 0);
    });

    it('skips [multis] prefixed messages to avoid cascade', async () => {
      const bp = makeBp(loadBeeper);
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));

      bp._api = fakeApi(
        [{ id: 'c1' }],
        { c1: [{ id: '10', senderID: 'self1', text: '[multis] some response' }] }
      );

      await bp._poll();
      assert.strictEqual(received.length, 0);
    });

    it('skips already-seen messages (dedup)', async () => {
      const bp = makeBp(loadBeeper);
      bp._lastSeen['c1'] = 10;
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));

      bp._api = fakeApi(
        [{ id: 'c1' }],
        { c1: [{ id: '10', senderID: 'self1', text: '//test' }] }
      );

      await bp._poll();
      assert.strictEqual(received.length, 0);
    });

    it('processes only new messages after lastSeen', async () => {
      const bp = makeBp(loadBeeper);
      bp._lastSeen['c1'] = 5;
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));

      bp._api = fakeApi(
        [{ id: 'c1' }],
        // Newest first (as returned by API)
        { c1: [
          { id: '8', senderID: 'self1', text: '//newer' },
          { id: '6', senderID: 'self1', text: '//older' },
          { id: '4', senderID: 'self1', text: '//skip' },
        ]}
      );

      await bp._poll();
      // Should skip id=4, process id=6 then id=8 (oldest first)
      assert.strictEqual(received.length, 2);
      assert.strictEqual(received[0].text, '//older');
      assert.strictEqual(received[1].text, '//newer');
      assert.strictEqual(bp._lastSeen['c1'], 8);
    });

    it('updates lastSeen after processing', async () => {
      const bp = makeBp(loadBeeper);
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));

      bp._api = fakeApi(
        [{ id: 'c1' }],
        { c1: [{ id: '42', senderID: 'self1', text: '//cmd' }] }
      );

      await bp._poll();
      assert.strictEqual(bp._lastSeen['c1'], 42);
    });

    it('creates normalized Message with correct fields', async () => {
      const bp = makeBp(loadBeeper);
      const received = [];
      bp.onMessage(async (msg) => received.push(msg));

      bp._api = fakeApi(
        [{ id: 'c1', title: 'Work Chat' }],
        { c1: [{ id: '10', senderID: 'self1', senderName: 'Me', text: '//help' }] }
      );

      await bp._poll();
      const m = received[0];
      assert.strictEqual(m.id, 10);
      assert.strictEqual(m.platform, 'beeper');
      assert.strictEqual(m.chatId, 'c1');
      assert.strictEqual(m.chatName, 'Work Chat');
      assert.strictEqual(m.senderId, 'self1');
      assert.strictEqual(m.senderName, 'Me');
      assert.strictEqual(m.isSelf, true);
    });

    it('handles handler errors without crashing poll', async () => {
      const bp = makeBp(loadBeeper);
      bp.onMessage(async () => { throw new Error('handler boom'); });

      bp._api = fakeApi(
        [{ id: 'c1' }],
        { c1: [{ id: '10', senderID: 'self1', text: '//fail' }] }
      );

      // Should not throw
      await bp._poll();
      assert.strictEqual(bp._lastSeen['c1'], 10);
    });

    it('handles poll API errors gracefully', async () => {
      const bp = makeBp(loadBeeper);
      bp._api = async () => { throw new Error('network error'); };
      // Should not throw
      await bp._poll();
    });

    it('logs poll error only once (suppresses repeated errors)', async () => {
      const bp = makeBp(loadBeeper);
      bp._api = async () => { throw new Error('network error'); };

      await bp._poll();
      assert.strictEqual(bp._pollErrorLogged, true);

      // Second poll — flag stays true, no duplicate log
      await bp._poll();
      assert.strictEqual(bp._pollErrorLogged, true);
    });

    it('clears poll error flag on success', async () => {
      const bp = makeBp(loadBeeper);
      bp._pollErrorLogged = true;
      bp._api = async () => ({ items: [] });

      await bp._poll();
      assert.strictEqual(bp._pollErrorLogged, false);
    });
  });
});

// ---------------------------------------------------------------------------
// Message class — Beeper-specific behavior
// ---------------------------------------------------------------------------

describe('Message (beeper)', () => {
  // Fresh require since HOME might differ
  const { Message } = require('../src/platforms/message');

  it('isCommand returns true for self // messages', () => {
    const m = new Message({ platform: 'beeper', text: '//status', isSelf: true });
    assert.strictEqual(m.isCommand(), true);
  });

  it('isCommand returns false for non-self // messages', () => {
    const m = new Message({ platform: 'beeper', text: '//status', isSelf: false });
    assert.strictEqual(m.isCommand(), false);
  });

  it('isCommand returns false for self plain text', () => {
    const m = new Message({ platform: 'beeper', text: 'hello', isSelf: true });
    assert.strictEqual(m.isCommand(), false);
  });

  it('commandText strips // prefix and trims', () => {
    const m = new Message({ platform: 'beeper', text: '//exec ls', isSelf: true });
    assert.strictEqual(m.commandText(), 'exec ls');
  });

  it('commandText returns raw text for non-command', () => {
    const m = new Message({ platform: 'beeper', text: 'hello world', isSelf: true });
    assert.strictEqual(m.commandText(), 'hello world');
  });

  it('parseCommand extracts command and args', () => {
    const m = new Message({ platform: 'beeper', text: '//read /etc/hosts', isSelf: true });
    const parsed = m.parseCommand();
    assert.strictEqual(parsed.command, 'read');
    assert.strictEqual(parsed.args, '/etc/hosts');
  });

  it('parseCommand returns null for non-commands', () => {
    const m = new Message({ platform: 'beeper', text: 'just chatting', isSelf: false });
    assert.strictEqual(m.parseCommand(), null);
  });
});
