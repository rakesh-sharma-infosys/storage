'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  keyEncode,
  keyDecode,
  keyStrictUpperBound,
  keyEncodedCompare,
  keyAssertValid,
} = require('../source/key.js');

function normalize(part) {
  if (part instanceof Uint8Array) return Array.from(part);
  if (typeof part === 'bigint') return `${part}n`;
  return part;
}

function roundtrip(key) {
  const decoded = keyDecode(keyEncode(key));
  assert.deepEqual(decoded.map(normalize), key.map(normalize));
}

test('roundtrips every supported key part type', () => {
  roundtrip(['hello']);
  roundtrip(['']);
  roundtrip([42]);
  roundtrip([-42]);
  roundtrip([0]);
  roundtrip([1.5]);
  roundtrip([-1.5]);
  roundtrip([Number.MAX_SAFE_INTEGER]);
  roundtrip([-Number.MAX_SAFE_INTEGER]);
  roundtrip([10n]);
  roundtrip([-10n]);
  roundtrip([0n]);
  roundtrip([true]);
  roundtrip([false]);
  roundtrip([new Uint8Array([1, 2, 3])]);
  roundtrip([new Uint8Array([0, 0, 1])]);
  roundtrip(['a', 1, true, 2n, new Uint8Array([9])]);
});

test('rejects malformed keys', () => {
  assert.throws(() => keyAssertValid([]), TypeError);
  assert.throws(() => keyAssertValid('not-an-array'), TypeError);
  assert.throws(() => keyAssertValid([null]), TypeError);
  assert.throws(() => keyAssertValid([undefined]), TypeError);
  assert.throws(() => keyAssertValid([{}]), TypeError);
  assert.throws(() => keyAssertValid([NaN]), TypeError);
});

test('rejects bigints outside the supported 64-bit signed range', () => {
  assert.throws(() => keyEncode([2n ** 63n]), RangeError);
  assert.throws(() => keyEncode([-(2n ** 63n) - 1n]), RangeError);
  assert.doesNotThrow(() => keyEncode([2n ** 63n - 1n]));
  assert.doesNotThrow(() => keyEncode([-(2n ** 63n)]));
});

test('byte ordering matches intended key ordering: strings', () => {
  const keys = [[''], ['a'], ['aa'], ['ab'], ['b']];
  const encoded = keys.map(keyEncode);
  for (let i = 0; i < encoded.length - 1; i++) {
    assert.ok(keyEncodedCompare(encoded[i], encoded[i + 1]) < 0, `${keys[i]} < ${keys[i + 1]}`);
  }
});

test('byte ordering matches intended key ordering: numbers (incl. negatives)', () => {
  const nums = [-1000.5, -1, -0.5, 0, 0.5, 1, 1000.5];
  const encoded = nums.map((n) => keyEncode([n]));
  for (let i = 0; i < encoded.length - 1; i++) {
    assert.ok(keyEncodedCompare(encoded[i], encoded[i + 1]) < 0, `${nums[i]} < ${nums[i + 1]}`);
  }
});

test('byte ordering matches intended key ordering: bigints', () => {
  const nums = [-100n, -1n, 0n, 1n, 100n];
  const encoded = nums.map((n) => keyEncode([n]));
  for (let i = 0; i < encoded.length - 1; i++) {
    assert.ok(keyEncodedCompare(encoded[i], encoded[i + 1]) < 0, `${nums[i]} < ${nums[i + 1]}`);
  }
});

test('type precedence: Uint8Array < string < bigint < number < boolean', () => {
  const parts = [new Uint8Array([0]), 'z', 0n, 0, false];
  const encoded = parts.map((p) => keyEncode([p]));
  for (let i = 0; i < encoded.length - 1; i++) {
    assert.ok(keyEncodedCompare(encoded[i], encoded[i + 1]) < 0);
  }
});

test('a key is always less than a longer key that extends it', () => {
  const short = keyEncode(['users']);
  const long = keyEncode(['users', 1]);
  assert.ok(keyEncodedCompare(short, long) < 0);
});

test('embedded zero bytes in strings/bytes round-trip and sort correctly', () => {
  roundtrip([new Uint8Array([1, 0, 0, 2])]);
  roundtrip(['a\x00b']);
  const a = keyEncode([new Uint8Array([1, 0, 2])]);
  const b = keyEncode([new Uint8Array([1, 2])]);
  assert.ok(keyEncodedCompare(a, b) < 0);
});

test('keyStrictUpperBound computes a correct exclusive prefix bound', () => {
  const prefix = keyEncode(['users']);
  const upper = keyStrictUpperBound(prefix);
  const withinPrefix = keyEncode(['users', 1]);
  const exact = keyEncode(['users']);
  const outsidePrefix = keyEncode(['userz']);
  assert.ok(keyEncodedCompare(exact, upper) < 0);
  assert.ok(keyEncodedCompare(withinPrefix, upper) < 0);
  assert.ok(keyEncodedCompare(outsidePrefix, upper) >= 0);
});

test('keyStrictUpperBound returns null for an all-0xFF prefix', () => {
  const prefix = Buffer.from([0xff, 0xff]);
  assert.equal(keyStrictUpperBound(prefix), null);
});
