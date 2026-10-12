'use strict';

/**
 * @fileoverview Order-preserving binary encoding for store keys.
 *
 * A store key is an array of "parts". Each part is one of:
 *   - Uint8Array (raw bytes)
 *   - string
 *   - bigint
 *   - number
 *   - boolean
 *
 * Keys must sort the same way whether compared as JS arrays (part by part,
 * same-type parts compared by natural order, with a defined total order
 * across different types) or compared as raw bytes (the way SQLite compares
 * BLOB primary keys). This module implements that mapping.
 *
 * Type precedence (ascending): Uint8Array < string < bigint < number < boolean.
 *
 * Variable-length parts (Uint8Array, string) are escaped so that 0x00 bytes
 * inside the part can never be confused with the part terminator: every 0x00
 * byte in the raw content is emitted as 0x00 0xFF, and the part is closed
 * with a 0x00 0x00 terminator. Because 0x00 0x00 sorts before 0x00 0xFF,
 * a part that is a strict prefix of another always sorts first, exactly as
 * plain byte/string comparison would.
 *
 * Fixed-length parts (bigint, number, boolean) use an order-preserving
 * transform so that big-endian byte comparison matches numeric comparison.
 */

const TAG_BYTES = 0x01;
const TAG_STRING = 0x02;
const TAG_BIGINT = 0x03;
const TAG_NUMBER = 0x04;
const TAG_BOOLEAN = 0x05;

// bigint key parts are stored as a fixed-width 8-byte signed magnitude. This
// keeps the encoding simple and fixed-length (no escaping needed) at the
// cost of supporting a smaller range than arbitrary-precision
// bigints.
const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

/**
 * Returns true if `value` is a valid single key part.
 * @param {unknown} value
 * @returns {boolean}
 */
function keyPartIsValid(value) {
  if (value instanceof Uint8Array) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'bigint') return true;
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'boolean') return true;
  return false;
}

/**
 * Validates that `key` is a well-formed store key (a non-empty array of valid
 * key parts). Throws a TypeError if not.
 * @param {unknown} key
 * @returns {asserts key is Array<Uint8Array|string|bigint|number|boolean>}
 */
function keyAssertValid(key) {
  if (!Array.isArray(key)) {
    throw new TypeError('key must be an array of key parts');
  }
  if (key.length === 0) {
    throw new TypeError('key must contain at least one part');
  }
  for (const part of key) {
    if (!keyPartIsValid(part)) {
      throw new TypeError(
        `invalid key part: ${String(part)} (must be Uint8Array, string, bigint, number, or boolean)`
      );
    }
  }
}

/**
 * Escapes raw bytes for use as a variable-length key part and appends the
 * part terminator.
 * @param {Uint8Array} bytes
 * @returns {number[]}
 */
function bytesEscape(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out.push(b);
    if (b === 0x00) out.push(0xff);
  }
  out.push(0x00, 0x00);
  return out;
}

/**
 * Encodes a float64 so that big-endian unsigned byte comparison matches
 * numeric comparison (IEEE-754 order-preserving transform).
 * @param {number} value
 * @returns {Buffer}
 */
function numberEncode(value) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(value, 0);
  if (buf[0] & 0x80) {
    // Negative: invert all bits.
    for (let i = 0; i < 8; i++) buf[i] = ~buf[i] & 0xff;
  } else {
    // Non-negative: flip the sign bit so positives sort after negatives.
    buf[0] |= 0x80;
  }
  return buf;
}

/**
 * Inverse of {@link numberEncode}.
 * @param {Buffer} buf 8-byte encoded number
 * @returns {number}
 */
function numberDecode(buf) {
  const copy = Buffer.from(buf);
  if (copy[0] & 0x80) {
    copy[0] &= 0x7f;
  } else {
    for (let i = 0; i < 8; i++) copy[i] = ~copy[i] & 0xff;
  }
  return copy.readDoubleBE(0);
}

/**
 * Encodes a bigint (restricted to a signed 64-bit range) as an
 * order-preserving 8-byte big-endian value.
 * @param {bigint} value
 * @returns {Buffer}
 */
function bigintEncode(value) {
  if (value < BIGINT_MIN || value > BIGINT_MAX) {
    throw new RangeError(
      `bigint key part out of supported range [${BIGINT_MIN}, ${BIGINT_MAX}]`
    );
  }
  const buf = Buffer.alloc(8);
  // Shift into unsigned space so two's-complement ordering becomes a plain
  // unsigned big-endian ordering.
  buf.writeBigUInt64BE(BigInt.asUintN(64, value - BIGINT_MIN));
  return buf;
}

/**
 * Encodes a full key (array of parts) into an order-preserving Buffer
 * suitable for use as a SQLite BLOB primary key.
 * @param {Array<Uint8Array|string|bigint|number|boolean>} key
 * @returns {Buffer}
 */
function keyEncode(key) {
  keyAssertValid(key);
  const chunks = [];
  for (const part of key) {
    if (part instanceof Uint8Array) {
      chunks.push(Buffer.from([TAG_BYTES]));
      chunks.push(Buffer.from(bytesEscape(part)));
    } else if (typeof part === 'string') {
      chunks.push(Buffer.from([TAG_STRING]));
      chunks.push(Buffer.from(bytesEscape(Buffer.from(part, 'utf8'))));
    } else if (typeof part === 'bigint') {
      chunks.push(Buffer.from([TAG_BIGINT]));
      chunks.push(bigintEncode(part));
    } else if (typeof part === 'number') {
      chunks.push(Buffer.from([TAG_NUMBER]));
      chunks.push(numberEncode(part));
    } else if (typeof part === 'boolean') {
      chunks.push(Buffer.from([TAG_BOOLEAN, part ? 1 : 0]));
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Decodes a Buffer produced by {@link keyEncode} back into a key (array of
 * parts).
 * @param {Buffer|Uint8Array} buf
 * @returns {Array<Uint8Array|string|bigint|number|boolean>}
 */
function keyDecode(buf) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const parts = [];
  let i = 0;
  while (i < buffer.length) {
    const tag = buffer[i];
    i += 1;
    if (tag === TAG_BYTES || tag === TAG_STRING) {
      const raw = [];
      while (true) {
        const b = buffer[i];
        if (b === 0x00) {
          const next = buffer[i + 1];
          if (next === 0x00) {
            i += 2;
            break;
          } else if (next === 0xff) {
            raw.push(0x00);
            i += 2;
            continue;
          }
        }
        raw.push(b);
        i += 1;
      }
      const rawBuf = Buffer.from(raw);
      parts.push(tag === TAG_BYTES ? new Uint8Array(rawBuf) : rawBuf.toString('utf8'));
    } else if (tag === TAG_BIGINT) {
      const chunk = buffer.subarray(i, i + 8);
      i += 8;
      const unsigned = chunk.readBigUInt64BE(0);
      parts.push(unsigned + BIGINT_MIN);
    } else if (tag === TAG_NUMBER) {
      const chunk = buffer.subarray(i, i + 8);
      i += 8;
      parts.push(numberDecode(chunk));
    } else if (tag === TAG_BOOLEAN) {
      parts.push(buffer[i] === 1);
      i += 1;
    } else {
      throw new Error(`corrupt key encoding: unknown tag byte 0x${tag.toString(16)}`);
    }
  }
  return parts;
}

/**
 * Computes the exclusive upper bound for a byte-prefix range scan: the
 * smallest buffer that is strictly greater than every buffer starting with
 * `prefix`. Returns `null` if the prefix is all 0xFF bytes (or empty), in
 * which case there is no finite upper bound (the scan should run to the end
 * of the keyspace).
 * @param {Buffer} prefix
 * @returns {Buffer|null}
 */
function keyStrictUpperBound(prefix) {
  const bytes = Buffer.from(prefix);
  let i = bytes.length - 1;
  while (i >= 0 && bytes[i] === 0xff) i--;
  if (i < 0) return null;
  const out = Buffer.from(bytes.subarray(0, i + 1));
  out[i] += 1;
  return out;
}

/**
 * Compares two encoded key buffers using the same ordering SQLite applies
 * to BLOB columns (unsigned byte-by-byte comparison).
 * @param {Buffer|Uint8Array} a
 * @param {Buffer|Uint8Array} b
 * @returns {-1|0|1}
 */
function keyEncodedCompare(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return Buffer.compare(ba, bb);
}

module.exports = {
  keyEncode,
  keyDecode,
  keyStrictUpperBound,
  keyEncodedCompare,
  keyPartIsValid,
  keyAssertValid,
};
