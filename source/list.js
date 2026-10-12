'use strict';

const { keyEncode, keyStrictUpperBound } = require('./key.js');

/**
 * @fileoverview Range resolution and the lazy, cursor-paginated async
 * iterator returned by `store.list()`.
 */

/**
 * Resolves a `{prefix, start, end}` list selector into an inclusive lower /
 * exclusive upper encoded-key byte range.
 * @param {{prefix?: Array, start?: Array, end?: Array}} selector
 * @returns {{lower: Buffer, upper: Buffer|null}}
 */
function listRangeResolve(selector) {
  const hasPrefix = selector.prefix !== undefined;
  const hasStart = selector.start !== undefined;
  const hasEnd = selector.end !== undefined;
  if (!hasPrefix && !(hasStart && hasEnd)) {
    throw new TypeError(
      'list selector must specify "prefix", or both "start" and "end"'
    );
  }
  if (hasPrefix) {
    const prefixEncoded = keyEncode(selector.prefix);
    const lower = hasStart ? keyEncode(selector.start) : prefixEncoded;
    const upper = hasEnd ? keyEncode(selector.end) : keyStrictUpperBound(prefixEncoded);
    return { lower, upper };
  }
  return { lower: keyEncode(selector.start), upper: keyEncode(selector.end) };
}

/**
 * Async iterator of matching entries, returned by `store.list()`. In addition
 * to the standard async-iterator protocol, exposes a `cursor` property that
 * always holds an opaque string identifying the position just after the
 * most recently yielded entry, suitable for passing back as
 * `options.cursor` to resume listing later.
 */
class StoreListIterator {
  /**
   * @param {import('./engine.js').SqliteTransactionEngine} engine
   * @param {{lower: Buffer, upper: Buffer|null, reverse: boolean}} range
   * @param {number} limit
   * @param {number} batchSize
   * @param {Buffer|null} cursorKey
   */
  constructor(engine, range, limit, batchSize, cursorKey) {
    this._engine = engine;
    this._range = range;
    this._limit = limit;
    this._batchSize = batchSize;
    this._cursorKey = cursorKey;
    this._buffer = [];
    this._bufferIdx = 0;
    this._count = 0;
    this._noMore = false;
    /** @type {string} Opaque cursor positioned after the last yielded entry. */
    this.cursor = cursorKey ? cursorKey.toString('base64') : '';
  }

  /**
   * @returns {Promise<IteratorResult<{key: Array, value: unknown, version: string}>>}
   */
  async next() {
    if (this._count >= this._limit) return { done: true, value: undefined };
    if (this._bufferIdx >= this._buffer.length) {
      if (this._noMore) return { done: true, value: undefined };
      const fetchLimit = Math.min(this._batchSize, this._limit - this._count);
      this._buffer = this._engine.range({
        lower: this._range.lower,
        upper: this._range.upper,
        reverse: this._range.reverse,
        limit: fetchLimit,
        cursorKey: this._cursorKey,
        now: Date.now(),
      });
      this._bufferIdx = 0;
      if (this._buffer.length < fetchLimit) this._noMore = true;
      if (this._buffer.length === 0) return { done: true, value: undefined };
    }
    const entry = this._buffer[this._bufferIdx++];
    this._count++;
    this._cursorKey = keyEncode(entry.key);
    this.cursor = this._cursorKey.toString('base64');
    return { done: false, value: entry };
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

module.exports = { StoreListIterator, listRangeResolve };
