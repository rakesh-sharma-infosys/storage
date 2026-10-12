'use strict';

const { keyAssertValid } = require('./key.js');
const { StoreU64 } = require('./value.js');

/**
 * @fileoverview `AtomicOperation`: a builder for a batch of checks and
 * mutations that are applied together, transactionally, when `commit()` is
 * called.
 */

/**
 * @param {bigint} n
 * @param {string} label
 */
function bigintAssert(n, label) {
  if (typeof n !== 'bigint') {
    throw new TypeError(`${label} must be a bigint`);
  }
}

/**
 * A chainable builder for a batch of checks and mutations that are applied
 * together, transactionally, when `commit()` is called. Obtain one via
 * `store.atomic()`; never construct directly.
 */
class AtomicOperation {
  /**
   * @param {import('./database.js').Store} store
   */
  constructor(store) {
    this._store = store;
    this._checks = [];
    this._mutations = [];
  }

  /**
   * Adds one or more preconditions that must hold for `commit()` to apply
   * this operation's mutations. A check passes when the key's current
   * version equals the given one; pass `version: null` to require
   * that the key does not currently exist.
   * @param {...{key: Array, version: string|null}} checks
   * @returns {this}
   */
  check(...checks) {
    for (const c of checks) {
      keyAssertValid(c.key);
      if (c.version !== null && typeof c.version !== 'string') {
        throw new TypeError('check version must be a string or null');
      }
      this._checks.push({ key: c.key, version: c.version });
    }
    return this;
  }

  /**
   * Queues a `set` mutation: writes `value` at `key`, optionally with a
   * time-to-live.
   * @param {Array} key
   * @param {unknown} value
   * @param {{expireIn?: number}} [options]
   * @returns {this}
   */
  set(key, value, options = {}) {
    keyAssertValid(key);
    this._mutations.push({ type: 'set', key, value, expireIn: options.expireIn });
    return this;
  }

  /**
   * Queues a `delete` mutation.
   * @param {Array} key
   * @returns {this}
   */
  delete(key) {
    keyAssertValid(key);
    this._mutations.push({ type: 'delete', key });
    return this;
  }

  /**
   * Queues a mutation that atomically adds `n` to the `StoreU64` stored at
   * `key` (treating a missing key as zero), wrapping on 64-bit overflow.
   * @param {Array} key
   * @param {bigint} n
   * @returns {this}
   */
  sum(key, n) {
    keyAssertValid(key);
    bigintAssert(n, 'sum operand');
    this._mutations.push({ type: 'sum', key, value: new StoreU64(n) });
    return this;
  }

  /**
   * Queues a mutation that sets the `StoreU64` at `key` to the minimum of its
   * current value (or `n`, if the key is missing) and `n`.
   * @param {Array} key
   * @param {bigint} n
   * @returns {this}
   */
  min(key, n) {
    keyAssertValid(key);
    bigintAssert(n, 'min operand');
    this._mutations.push({ type: 'min', key, value: new StoreU64(n) });
    return this;
  }

  /**
   * Queues a mutation that sets the `StoreU64` at `key` to the maximum of its
   * current value (or `n`, if the key is missing) and `n`.
   * @param {Array} key
   * @param {bigint} n
   * @returns {this}
   */
  max(key, n) {
    keyAssertValid(key);
    bigintAssert(n, 'max operand');
    this._mutations.push({ type: 'max', key, value: new StoreU64(n) });
    return this;
  }

  /**
   * Queues a message to be delivered to this Store's queue listener(s).
   * @param {unknown} value
   * @param {{delay?: number, backoffSchedule?: number[], keysIfUndelivered?: Array[]}} [options]
   * @returns {this}
   */
  enqueue(value, options = {}) {
    this._mutations.push({
      type: 'enqueue',
      value,
      delay: options.delay,
      backoffSchedule: options.backoffSchedule,
      keysIfUndelivered: options.keysIfUndelivered,
    });
    return this;
  }

  /**
   * Queues one or more mutations expressed as plain objects (an
   * alternative to calling `set`/`delete`/`sum`/`min`/`max` individually).
   * @param {...{type: 'set'|'delete'|'sum'|'min'|'max', key: Array, value?: unknown}} mutations
   * @returns {this}
   */
  mutate(...mutations) {
    for (const m of mutations) {
      if (m.type === 'set') this.set(m.key, m.value, m.options);
      else if (m.type === 'delete') this.delete(m.key);
      else if (m.type === 'sum') this.sum(m.key, m.value.value);
      else if (m.type === 'min') this.min(m.key, m.value.value);
      else if (m.type === 'max') this.max(m.key, m.value.value);
      else throw new TypeError(`unknown mutation type: ${m.type}`);
    }
    return this;
  }

  /**
   * Applies this operation's checks and mutations transactionally. If any
   * check fails, nothing is written and `{ok: false}` is returned.
   * @returns {Promise<{ok: true, version: string}|{ok: false}>}
   */
  async commit() {
    this._store._openAssert();
    const version = this._store._engine.commit(this._checks, this._mutations);
    if (version === null) {
      return { ok: false };
    }
    this._store._changeNotify(this._mutations);
    return { ok: true, version };
  }
}

module.exports = { AtomicOperation };
