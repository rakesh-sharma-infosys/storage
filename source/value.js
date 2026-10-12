'use strict';

const v8 = require('node:v8');

/**
 * @fileoverview Value (de)serialization for stored entries.
 *
 * Plain values are serialized with Node's built-in V8 structured-clone
 * serializer (`node:v8`), which supports objects, arrays, Dates, Maps, Sets,
 * RegExps, TypedArrays, and other structured-cloneable values without
 * pulling in any external dependency.
 *
 * `StoreU64` values (a wrapper around a non-negative 64-bit bigint) are stored as a raw 8-byte little-endian unsigned integer so
 * that atomic `sum`/`min`/`max` mutations can read-modify-write them without
 * going through the general serializer.
 */

const KIND_BYTES = 0; // tag byte for the raw/u64 branch
const KIND_VALUE = 1; // tag byte for the general v8-serialized branch

/**
 * A 64-bit unsigned integer wrapper used for atomic `sum`, `min`, and `max`
 * mutations. Instances are immutable.
 */
class StoreU64 {
  /**
   * @param {bigint} value A non-negative integer that fits in 64 bits.
   */
  constructor(value) {
    if (typeof value !== 'bigint') {
      throw new TypeError('StoreU64 value must be a bigint');
    }
    if (value < 0n || value > 0xffffffffffffffffn) {
      throw new RangeError('StoreU64 value must be in the range [0, 2^64 - 1]');
    }
    /** @readonly @type {bigint} */
    this.value = value;
    Object.freeze(this);
  }
}

/**
 * Serializes a stored value (either a `StoreU64` or an arbitrary structured
 * value) to a Buffer for persistence.
 * @param {unknown} value
 * @returns {Buffer}
 */
function valueEncode(value) {
  if (value instanceof StoreU64) {
    const buf = Buffer.alloc(9);
    buf[0] = KIND_BYTES;
    buf.writeBigUInt64LE(value.value, 1);
    return buf;
  }
  const serialized = v8.serialize(value);
  return Buffer.concat([Buffer.from([KIND_VALUE]), serialized]);
}

/**
 * Inverse of {@link valueEncode}.
 * @param {Buffer|Uint8Array} buf
 * @returns {unknown}
 */
function valueDecode(buf) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const kind = buffer[0];
  const rest = buffer.subarray(1);
  if (kind === KIND_BYTES) {
    return new StoreU64(rest.readBigUInt64LE(0));
  }
  return v8.deserialize(rest);
}

module.exports = {
  StoreU64,
  valueEncode,
  valueDecode,
};
