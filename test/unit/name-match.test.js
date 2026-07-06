const { describe, it } = require('node:test');
const assert = require('node:assert');

const { nameIsCalled } = require('../../src/bot/name-match');

// M8 module 1 — the personal-mode trigger. In `personal` mode the bot responds ONLY when the
// assistant's name is called. Match (PRD §524): case-insensitive, word-boundary, ANY whitespace-split
// token of the name. `"Roger bot"` fires on `roger` OR `bot`; word-boundary so `robot`/`chatbot` do NOT.
describe('nameIsCalled', () => {
  it('fires on a single-token name, case-insensitively', () => {
    assert.equal(nameIsCalled('hey Roger can you help', 'Roger'), true);
    assert.equal(nameIsCalled('HEY ROGER', 'roger'), true);
    assert.equal(nameIsCalled('roger', 'Roger'), true);
  });

  it('fires on ANY token of a multi-word name', () => {
    assert.equal(nameIsCalled('roger, are you there', 'Roger bot'), true, 'first token');
    assert.equal(nameIsCalled('are you there bot?', 'Roger bot'), true, 'second token');
  });

  it('does not fire when the name is absent', () => {
    assert.equal(nameIsCalled('hello there, how are you', 'Roger'), false);
  });

  it('respects word boundaries — the load-bearing case', () => {
    // `bot` is a real token; `robot`/`chatbot`/`reboot` embed it but must NOT fire.
    assert.equal(nameIsCalled('bot help', 'bot'), true);
    assert.equal(nameIsCalled('the robot moved', 'bot'), false);
    assert.equal(nameIsCalled('open the chatbot', 'bot'), false);
    assert.equal(nameIsCalled('please reboot', 'bot'), false);
    // Trailing-letter attachment: a surname "Rogers" must not fire "roger".
    assert.equal(nameIsCalled('the Rogers family', 'roger'), false);
  });

  it('treats punctuation as a boundary (name touching . , ! ? still fires)', () => {
    assert.equal(nameIsCalled('roger!', 'roger'), true);
    assert.equal(nameIsCalled('hey, roger.', 'roger'), true);
    assert.equal(nameIsCalled('(roger)', 'roger'), true);
  });

  it('returns false for an empty/whitespace name or empty text (no trigger)', () => {
    assert.equal(nameIsCalled('roger', ''), false);
    assert.equal(nameIsCalled('roger', '   '), false);
    assert.equal(nameIsCalled('', 'roger'), false);
  });

  it('is defensive against non-string inputs', () => {
    assert.equal(nameIsCalled(undefined, 'roger'), false);
    assert.equal(nameIsCalled('roger', undefined), false);
    assert.equal(nameIsCalled(null, null), false);
    assert.equal(nameIsCalled(42, 'roger'), false);
  });

  it('escapes regex metacharacters in the name (no wildcard, no throw)', () => {
    // A `.` in the name must be literal, not "any char" — "a.c" must NOT match "abc".
    assert.equal(nameIsCalled('abc', 'a.c'), false);
    assert.equal(nameIsCalled('a.c here', 'a.c'), true);
    // Must not throw on metachars that would break an unescaped regex.
    assert.doesNotThrow(() => nameIsCalled('some text', 'c++'));
    assert.doesNotThrow(() => nameIsCalled('some text', '('));
  });

  it('ignores extra whitespace between name tokens', () => {
    assert.equal(nameIsCalled('call the bot', '  Roger   bot  '), true);
  });
});
