'use strict';

const { randomUUIDv7 } = require('node:crypto');

/**
 * @fileoverview Version generation.
 *
 * A version is a UUIDv7 string (RFC 9562, 36 lowercase chars with dashes)
 * produced by Node's native `crypto.randomUUIDv7()`: a 48-bit millisecond
 * timestamp followed by random bits. Versions therefore sort lexicographically
 * in (roughly) commit order and are unique across databases.
 *
 * `randomUUIDv7()` alone does not guarantee ordering between two calls made
 * in the same millisecond, so {@link versionNext} keeps the last issued value
 * and bumps its low random bits when a fresh UUID would not sort after it.
 * That makes versions strictly increasing within a process. Every key written
 * in a single commit shares the same version.
 */

const VERSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Low 62 bits (rand_b) of the UUID; incrementing within them never disturbs
// the version or variant bits.
const RAND_B_MASK = (1n << 62n) - 1n;

let lastVersion = '';

/**
 * Returns the UUID that immediately follows `uuid` in sort order, or `null`
 * if the increment would overflow into the variant bits.
 * @param {string} uuid
 * @returns {string|null}
 */
function uuidIncrement(uuid) {
  const n = BigInt(`0x${uuid.replaceAll('-', '')}`);
  if ((n & RAND_B_MASK) === RAND_B_MASK) return null;
  const hex = (n + 1n).toString(16).padStart(32, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * Generates a new version that sorts strictly after every version previously
 * returned by this function in this process.
 * @returns {string} a UUIDv7 string
 */
function versionNext() {
  let candidate = randomUUIDv7();
  if (candidate <= lastVersion) {
    candidate = uuidIncrement(lastVersion) ?? randomUUIDv7();
  }
  lastVersion = candidate;
  return candidate;
}

/**
 * Returns true if `value` is a syntactically valid version string.
 * @param {unknown} value
 * @returns {boolean}
 */
function versionIsValid(value) {
  return typeof value === 'string' && VERSION_RE.test(value);
}

module.exports = {
  versionNext,
  versionIsValid,
};
