'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { versionNext, versionIsValid } = require('../source/version.js');

test('versionNext returns valid UUIDv7 strings', () => {
  const v = versionNext();
  assert.ok(versionIsValid(v));
  assert.equal(v.length, 36);
});

test('versionNext is strictly increasing, even within one millisecond', () => {
  let prev = versionNext();
  for (let i = 0; i < 100_000; i++) {
    const next = versionNext();
    assert.ok(next > prev, `${next} should sort after ${prev}`);
    assert.ok(versionIsValid(next));
    prev = next;
  }
});

test('versionIsValid rejects malformed values', () => {
  assert.equal(versionIsValid(null), false);
  assert.equal(versionIsValid('0000000000000001' + '0000'), false);
  assert.equal(versionIsValid('01a13068-6599-4943-9394-c8b76c0ec0fa'), false); // v4
});
