'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { valueEncode, valueDecode, StoreU64 } = require('../source/value.js');

test('roundtrips primitive and structured values', () => {
  const samples = [
    42,
    -1.5,
    'hello',
    true,
    false,
    null,
    { a: 1, b: { c: [1, 2, 3] } },
    [1, 'two', 3n, true],
    new Date('2024-01-01T00:00:00.000Z'),
    new Map([['a', 1], ['b', 2]]),
    new Set([1, 2, 3]),
    new Uint8Array([1, 2, 3]),
  ];
  for (const value of samples) {
    const decoded = valueDecode(valueEncode(value));
    assert.deepEqual(decoded, value);
  }
});

test('StoreU64 roundtrips as a raw 8-byte value', () => {
  const value = new StoreU64(123456789012345n);
  const decoded = valueDecode(valueEncode(value));
  assert.ok(decoded instanceof StoreU64);
  assert.equal(decoded.value, 123456789012345n);
});

test('StoreU64 rejects non-bigint and out-of-range values', () => {
  assert.throws(() => new StoreU64(1), TypeError);
  assert.throws(() => new StoreU64(-1n), RangeError);
  assert.throws(() => new StoreU64(2n ** 64n), RangeError);
  assert.doesNotThrow(() => new StoreU64(0n));
  assert.doesNotThrow(() => new StoreU64(2n ** 64n - 1n));
});

test('StoreU64 instances are immutable', () => {
  const u = new StoreU64(5n);
  assert.throws(() => {
    u.value = 10n;
  });
});
