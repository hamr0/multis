const { describe, it } = require('node:test');
const assert = require('node:assert');

const { disambiguateTitles } = require('../../src/bot/handlers');

// Two WhatsApp rooms for one contact share a title — in a numbered picker they
// look identical, so a mode set lands on the wrong room with no error (the
// silent no-op that broke the live business test). Colliding titles get the
// last-active date appended; unique titles stay clean. Selection is by number.
describe('disambiguateTitles', () => {
  it('leaves a unique title untouched', () => {
    const chats = [{ id: '!a', title: 'Nadia' }];
    const labels = disambiguateTitles(chats, { chats: {} });
    assert.equal(labels.get('!a'), 'Nadia');
  });

  it('appends the active date to same-titled chats so each is distinguishable', () => {
    const chats = [
      { id: '!uKkw', title: 'Amr Hassan' },
      { id: '!ovoH', title: 'Amr Hassan' },
    ];
    const config = { chats: {
      '!uKkw': { lastActive: '2026-06-19T10:00:00.000Z' },
      '!ovoH': { lastActive: '2026-06-22T15:34:00.000Z' },
    } };
    const labels = disambiguateTitles(chats, config);

    assert.equal(labels.get('!uKkw'), 'Amr Hassan · active 2026-06-19');
    assert.equal(labels.get('!ovoH'), 'Amr Hassan · active 2026-06-22');
    // The core property: the two labels MUST differ (the bug was identical lines).
    assert.notEqual(labels.get('!uKkw'), labels.get('!ovoH'));
  });

  it('does not disambiguate a uniquely-named chat sharing the list with a collision', () => {
    const chats = [
      { id: '!a', title: 'Amr Hassan' },
      { id: '!b', title: 'Amr Hassan' },
      { id: '!c', title: 'Nadia' },
    ];
    const labels = disambiguateTitles(chats, { chats: {
      '!a': { lastActive: '2026-06-22T00:00:00.000Z' },
      '!b': { lastActive: '2026-06-19T00:00:00.000Z' },
    } });
    assert.equal(labels.get('!c'), 'Nadia'); // untouched — no collision
    assert.match(labels.get('!a'), /active 2026-06-22/);
  });

  it('labels a colliding chat with no lastActive as "no activity" (still distinct from a dated sibling)', () => {
    const chats = [
      { id: '!a', title: 'Amr Hassan' },
      { id: '!b', title: 'Amr Hassan' },
    ];
    const labels = disambiguateTitles(chats, { chats: {
      '!a': { lastActive: '2026-06-22T00:00:00.000Z' },
    } });
    assert.equal(labels.get('!b'), 'Amr Hassan · active no activity');
    assert.notEqual(labels.get('!a'), labels.get('!b'));
  });

  it('does not throw on a malformed lastActive — falls back to "no activity"', () => {
    const chats = [
      { id: '!a', title: 'Amr Hassan' },
      { id: '!b', title: 'Amr Hassan' },
    ];
    const config = { chats: {
      '!a': { lastActive: 'not-a-date' },        // corrupted / hand-edited
      '!b': { lastActive: '2026-06-22T00:00:00.000Z' },
    } };
    let labels;
    assert.doesNotThrow(() => { labels = disambiguateTitles(chats, config); });
    assert.equal(labels.get('!a'), 'Amr Hassan · active no activity');
    assert.equal(labels.get('!b'), 'Amr Hassan · active 2026-06-22');
  });

  it('falls back to id when a chat has no title', () => {
    const chats = [{ id: '!only', network: 'whatsapp' }];
    const labels = disambiguateTitles(chats, { chats: {} });
    assert.equal(labels.get('!only'), '!only');
  });
});
