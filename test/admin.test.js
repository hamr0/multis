const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { isAdmin, addAdmin, removeAdmin, setMultisDir } = require('../src/config');
const { createMessageRouter } = require('../src/bot/handlers');
const { hashPin } = require('../src/security/pin');
const { createTestEnv, mockPlatform, mockLLM, msg } = require('./helpers/setup');

function stubIndexer() {
  return { search: () => [], getStats: () => ({ indexedFiles: 0, totalChunks: 0, byType: {} }),
    store: { recordSearchAccess() {}, search: () => [], recentByType: () => [] } };
}

describe('admin model helpers', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multis-admin-')); setMultisDir(tmp); });
  after(() => { setMultisDir(null); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('owner and beeper-self are always admin', () => {
    assert.ok(isAdmin('u1', { owner_id: 'u1', admins: [] }, {}));
    assert.ok(isAdmin('anyone', { owner_id: 'u1', admins: [] }, { isSelf: true }));
  });

  it('a designated chat is a limited admin; others are not', () => {
    const config = { owner_id: 'u1', admins: ['c2'] };
    assert.ok(isAdmin('sender', config, { chatId: 'c2' }));
    assert.ok(!isAdmin('sender', config, { chatId: 'c9' }));
  });

  it('addAdmin is idempotent and removeAdmin reverses it', () => {
    const config = { owner_id: 'u1', admins: [] };
    addAdmin(config, 'c2'); addAdmin(config, 'c2');
    assert.deepStrictEqual(config.admins, ['c2']);
    assert.strictEqual(removeAdmin(config, 'c2'), true);
    assert.deepStrictEqual(config.admins, []);
    assert.strictEqual(removeAdmin(config, 'c2'), false, 'removing a non-admin returns false');
  });
});

describe('/admin designation flow', () => {
  let env;
  afterEach(() => env && env.cleanup());

  it('owner designates a limited admin: pick → confirm → PIN', async () => {
    env = createTestEnv({
      allowed_users: ['user1'], owner_id: 'user1',
      security: { pin_hash: hashPin('1234') },
      chats: { cust_chat: { name: 'Acme', platform: 'beeper', lastActive: '2026-01-01T00:00:00Z' } }
    });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });

    await router(msg('/admin', { senderId: 'user1', chatId: 'owner_chat' }), platform);
    assert.match(platform.lastTo('owner_chat').text, /Acme/, 'lists the eligible chat');

    await router(msg('1', { senderId: 'user1', chatId: 'owner_chat' }), platform);
    assert.match(platform.lastTo('owner_chat').text, /confirm/i);

    await router(msg('yes', { senderId: 'user1', chatId: 'owner_chat' }), platform);
    assert.match(platform.lastTo('owner_chat').text, /PIN/i);

    assert.ok(!(env.config.admins || []).includes('cust_chat'), 'not added until PIN verified');
    await router(msg('1234', { senderId: 'user1', chatId: 'owner_chat' }), platform);
    assert.match(platform.lastTo('owner_chat').text, /limited admin/i);
    assert.ok(env.config.admins.includes('cust_chat'), 'added after correct PIN');
  });

  it('a wrong PIN does NOT promote the chat', async () => {
    env = createTestEnv({
      allowed_users: ['user1'], owner_id: 'user1',
      security: { pin_hash: hashPin('1234') },
      chats: { cust_chat: { name: 'Acme', platform: 'beeper' } }
    });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });
    await router(msg('/admin', { senderId: 'user1', chatId: 'oc' }), platform);
    await router(msg('1', { senderId: 'user1', chatId: 'oc' }), platform);
    await router(msg('yes', { senderId: 'user1', chatId: 'oc' }), platform);
    await router(msg('0000', { senderId: 'user1', chatId: 'oc' }), platform);
    assert.match(platform.lastTo('oc').text, /Wrong PIN/);
    assert.ok(!(env.config.admins || []).includes('cust_chat'));
  });

  it('is owner-only', async () => {
    env = createTestEnv({ allowed_users: ['user1', 'user2'], owner_id: 'user1' });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });
    await router(msg('/admin', { senderId: 'user2', chatId: 'c' }), platform);
    assert.match(platform.lastTo('c').text, /Owner only/);
  });

  it('/admin list and /admin remove manage the set', async () => {
    env = createTestEnv({
      allowed_users: ['user1'], owner_id: 'user1', admins: ['cust_chat'],
      chats: { cust_chat: { name: 'Acme' } }
    });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });

    await router(msg('/admin list', { senderId: 'user1', chatId: 'oc' }), platform);
    assert.match(platform.lastTo('oc').text, /Acme/);

    await router(msg('/admin remove 1', { senderId: 'user1', chatId: 'oc' }), platform);
    assert.match(platform.lastTo('oc').text, /Removed/);
    assert.ok(!env.config.admins.includes('cust_chat'));
  });
});

describe('limited admin authorization', () => {
  let env;
  afterEach(() => env && env.cleanup());

  it('a limited admin cannot run /exec (shell stays owner-only)', async () => {
    env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1', admins: ['cust_chat'] });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });
    await router(msg('/exec ls', { senderId: 'cust1', chatId: 'cust_chat' }), platform);
    assert.match(platform.lastTo('cust_chat').text, /Owner only/);
  });

  it('a limited admin CAN run /mode (not rejected)', async () => {
    env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1', admins: ['cust_chat'],
      chats: { other: { name: 'Other', platform: 'beeper' } } });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });
    // The beeper adapter marks a designated chat with isAdminChat so its /commands route.
    await router(msg('/mode', { senderId: 'cust1', chatId: 'cust_chat', platform: 'beeper', isAdminChat: true }), platform);
    const reply = platform.lastTo('cust_chat');
    assert.ok(reply && !/Admin only/.test(reply.text), 'limited admin is not refused /mode');
  });

  it('a non-admin customer still cannot run commands', async () => {
    env = createTestEnv({ allowed_users: ['user1'], owner_id: 'user1', admins: [] });
    const platform = mockPlatform();
    const router = createMessageRouter(env.config, { llm: mockLLM(), indexer: stubIndexer() });
    await router(msg('/mode', { senderId: 'cust1', chatId: 'cust_chat', platform: 'beeper' }), platform);
    // Non-paired, non-admin on beeper → silently dropped (no command output).
    assert.strictEqual(platform.lastTo('cust_chat'), undefined);
  });
});
