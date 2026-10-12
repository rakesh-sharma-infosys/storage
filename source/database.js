'use strict';

const { DatabaseSync } = require('node:sqlite');
const { schemaInit } = require('./schema.js');
const { SqliteTransactionEngine } = require('./engine.js');
const { AtomicOperation } = require('./atomic.js');
const { StoreListIterator, listRangeResolve } = require('./list.js');
const { keyAssertValid, keyDecode } = require('./key.js');
const { valueDecode } = require('./value.js');

/** @typedef {Array<Uint8Array|string|bigint|number|boolean>} StoreKey */
/** @typedef {{key: StoreKey, value: unknown, version: string}} StoreEntry */
/** @typedef {{key: StoreKey, value: null, version: null}} StoreEmptyEntry */

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_QUEUE_POLL_INTERVAL_MS = 50;
const DEFAULT_QUEUE_VISIBILITY_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_BATCH_SIZE = 100;

/**
 * A SQLite-backed key-value store with a key-value API. Create
 * an instance with {@link storageKV} rather than calling the constructor
 * directly.
 */
class Store {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{expireCheckIntervalMs?: number, queuePollIntervalMs?: number, queueVisibilityTimeoutMs?: number}} [options]
   */
  constructor(db, options = {}) {
    this._db = db;
    this._engine = new SqliteTransactionEngine(db);
    this._closed = false;
    this._watchers = new Set();
    this._queueHandler = null;
    this._queueTimer = null;
    this._queueStopResolvers = [];
    this._queuePollIntervalMs = options.queuePollIntervalMs ?? DEFAULT_QUEUE_POLL_INTERVAL_MS;
    this._queueVisibilityTimeoutMs =
      options.queueVisibilityTimeoutMs ?? DEFAULT_QUEUE_VISIBILITY_TIMEOUT_MS;

    const sweepIntervalMs = options.expireCheckIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this._sweepTimer = null;
    if (sweepIntervalMs > 0) {
      this._sweepTimer = setInterval(() => {
        try {
          this._engine.expiredSweep(Date.now());
        } catch {
          // Best-effort background cleanup; a failure here must never crash
          // the process or surface to callers.
        }
      }, sweepIntervalMs);
      this._sweepTimer.unref?.();
    }
  }

  /** @throws {Error} if this Store instance has been closed */
  _openAssert() {
    if (this._closed) {
      throw new Error('this Store instance has been closed');
    }
  }

  /**
   * Notifies active `watch()` listeners that a commit touched the store.
   * Listeners re-read only the specific keys they are watching, so this is
   * safe to call unconditionally on every successful commit.
   * @param {Array<object>} _mutations
   */
  _changeNotify(_mutations) {
    for (const listener of this._watchers) listener();
  }

  /**
   * Reads the current value of a single key.
   * @param {StoreKey} key
   * @param {{consistency?: 'strong'|'eventual'}} [_options] Accepted for API
   *   compatibility; every read is strongly consistent since there is only
   *   one (local) copy of the data.
   * @returns {Promise<StoreEntry|StoreEmptyEntry>}
   */
  async get(key, _options) {
    this._openAssert();
    keyAssertValid(key);
    const entry = this._engine.entryGet(key, Date.now());
    return entry ?? { key, value: null, version: null };
  }

  /**
   * Reads the current values of multiple keys in one call.
   * @param {StoreKey[]} keys
   * @param {{consistency?: 'strong'|'eventual'}} [_options]
   * @returns {Promise<Array<StoreEntry|StoreEmptyEntry>>}
   */
  async getMany(keys, _options) {
    this._openAssert();
    const now = Date.now();
    return keys.map((key) => {
      keyAssertValid(key);
      return this._engine.entryGet(key, now) ?? { key, value: null, version: null };
    });
  }

  /**
   * Writes `value` at `key`, overwriting any existing entry.
   * @param {StoreKey} key
   * @param {unknown} value
   * @param {{expireIn?: number}} [options] `expireIn` is a relative TTL in
   *   milliseconds.
   * @returns {Promise<{ok: true, version: string}>}
   */
  async set(key, value, options = {}) {
    this._openAssert();
    const result = await this.atomic().set(key, value, options).commit();
    return /** @type {{ok: true, version: string}} */ (result);
  }

  /**
   * Deletes the entry at `key`, if any.
   * @param {StoreKey} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    this._openAssert();
    await this.atomic().delete(key).commit();
  }

  /**
   * Lists entries matching a selector, ordered by key.
   * @param {{prefix?: StoreKey, start?: StoreKey, end?: StoreKey}} selector
   * @param {{limit?: number, cursor?: string, reverse?: boolean, batchSize?: number}} [options]
   * @returns {StoreListIterator}
   */
  list(selector, options = {}) {
    this._openAssert();
    const { lower, upper } = listRangeResolve(selector);
    const reverse = !!options.reverse;
    const limit = typeof options.limit === 'number' ? options.limit : Infinity;
    const batchSize = Math.max(
      1,
      Math.min(options.batchSize || DEFAULT_LIST_BATCH_SIZE, limit === Infinity ? Infinity : limit)
    );
    const cursorKey = options.cursor ? Buffer.from(options.cursor, 'base64') : null;
    return new StoreListIterator(this._engine, { lower, upper, reverse }, limit, batchSize, cursorKey);
  }

  /**
   * Creates a new {@link AtomicOperation} builder for batching checks and
   * mutations into a single transactional commit.
   * @returns {AtomicOperation}
   */
  atomic() {
    this._openAssert();
    return new AtomicOperation(this);
  }

  /**
   * Enqueues a value for delivery to this Store's queue listener(s).
   * @param {unknown} value
   * @param {{delay?: number, backoffSchedule?: number[], keysIfUndelivered?: StoreKey[]}} [options]
   * @returns {Promise<{ok: true, version: string}>}
   */
  async enqueue(value, options = {}) {
    this._openAssert();
    const result = await this.atomic().enqueue(value, options).commit();
    return /** @type {{ok: true, version: string}} */ (result);
  }

  /**
   * Registers a handler that is invoked for every message enqueued with
   * {@link Store#enqueue}, polling internally for newly available messages.
   * Only one listener may be active per Store instance. The returned promise
   * resolves once this Store instance is closed.
   *
   * Delivery is at-least-once: if `handler` throws (or returns a rejected
   * promise), the message is retried after a backoff delay, up to the
   * configured (or default) backoff schedule, after which it is written to
   * `options.keysIfUndelivered` (if provided when enqueued) and dropped.
   * @param {(value: unknown) => void|Promise<void>} handler
   * @returns {Promise<void>}
   */
  listenQueue(handler) {
    this._openAssert();
    if (this._queueHandler) {
      throw new Error('listenQueue() is already active for this Store instance');
    }
    this._queueHandler = handler;
    // Deliberately not unref'd: an active queue listener should keep the
    // process alive (like a server), matching the semantics of the Promise
    // this method returns, which only resolves once the Store is closed.
    this._queueTimer = setInterval(() => {
      this._queueDrain().catch((err) => {
        queueMicrotask(() => {
          throw err;
        });
      });
    }, this._queuePollIntervalMs);
    return new Promise((resolve) => {
      this._queueStopResolvers.push(resolve);
    });
  }

  /**
   * Drains and processes every currently-due queue message, one at a time,
   * up to a generous per-tick cap. Looping here (rather than processing one
   * message per timer tick) matters because the OS timer tick itself is
   * typically coarser than `queuePollIntervalMs` (commonly ~15ms on
   * Windows) — without draining, throughput would be capped at roughly one
   * message per timer tick regardless of how fast messages can actually be
   * processed.
   */
  async _queueDrain() {
    const maxPerTick = 1000;
    for (let i = 0; i < maxPerTick; i++) {
      const processed = await this._queuePoll();
      if (!processed || this._closed) return;
    }
  }

  /**
   * Claims and processes at most one due queue message.
   * @returns {Promise<boolean>} true if a message was claimed (whether or
   *   not its handler succeeded), false if none was due.
   */
  async _queuePoll() {
    if (this._closed) return false;
    const now = Date.now();
    let claimed = null;
    this._db.exec('BEGIN IMMEDIATE');
    try {
      claimed = this._db
        .prepare('SELECT * FROM queue WHERE available_at <= ? ORDER BY id LIMIT 1')
        .get(now);
      if (claimed) {
        this._db
          .prepare('UPDATE queue SET available_at = ? WHERE id = ?')
          .run(now + this._queueVisibilityTimeoutMs, claimed.id);
      }
      this._db.exec('COMMIT');
    } catch (err) {
      this._db.exec('ROLLBACK');
      throw err;
    }
    if (!claimed) return false;

    const value = valueDecode(claimed.value);
    let handlerFailed = false;
    try {
      await this._queueHandler(value);
    } catch {
      handlerFailed = true;
    }
    // The Store may have been closed while `handler` was running; the
    // underlying connection is gone, so there is nothing left to update.
    if (this._closed) return true;

    if (!handlerFailed) {
      this._db.prepare('DELETE FROM queue WHERE id = ?').run(claimed.id);
    } else {
      const attempts = claimed.attempts + 1;
      const backoff = JSON.parse(claimed.backoff_schedule);
      if (attempts > backoff.length) {
        const keysIfUndelivered = claimed.keys_if_undelivered
          ? JSON.parse(claimed.keys_if_undelivered)
          : [];
        if (keysIfUndelivered.length) {
          const mutations = keysIfUndelivered.map((b64) => ({
            type: 'set',
            key: keyDecode(Buffer.from(b64, 'base64')),
            value,
          }));
          this._engine.commit([], mutations);
        }
        this._db.prepare('DELETE FROM queue WHERE id = ?').run(claimed.id);
      } else {
        const delay = backoff[attempts - 1];
        this._db
          .prepare('UPDATE queue SET attempts = ?, available_at = ? WHERE id = ?')
          .run(attempts, Date.now() + delay, claimed.id);
      }
    }
    return true;
  }

  /**
   * Subscribes to changes on a fixed set of keys. The returned async
   * iterable immediately yields the current state of `keys`, then yields
   * again every time any commit completes (re-reading all watched keys each
   * time). Stop watching by calling `.return()` on the iterator (done
   * automatically by `for await...of` on `break`).
   * @param {StoreKey[]} keys
   * @returns {AsyncIterableIterator<Array<StoreEntry|StoreEmptyEntry>>}
   */
  watch(keys) {
    this._openAssert();
    keys.forEach(keyAssertValid);
    const store = this;
    /** @type {Array<Array<StoreEntry|StoreEmptyEntry>>} */
    const pending = [];
    /** @type {((r: IteratorResult<Array<StoreEntry|StoreEmptyEntry>>) => void)|null} */
    let waiting = null;
    let closed = false;

    const emit = () => {
      const now = Date.now();
      const snapshot = keys.map(
        (key) => store._engine.entryGet(key, now) ?? { key, value: null, version: null }
      );
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ done: false, value: snapshot });
      } else {
        pending.push(snapshot);
      }
    };

    store._watchers.add(emit);
    queueMicrotask(emit);

    return {
      async next() {
        if (closed) return { done: true, value: undefined };
        if (pending.length) return { done: false, value: pending.shift() };
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
      async return(value) {
        closed = true;
        store._watchers.delete(emit);
        if (waiting) {
          waiting({ done: true, value: undefined });
          waiting = null;
        }
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  /** Closes the underlying database connection and stops all background timers. */
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    if (this._queueTimer) clearInterval(this._queueTimer);
    for (const resolve of this._queueStopResolvers) resolve();
    this._queueStopResolvers = [];
    this._watchers.clear();
    this._db.close();
  }

  [Symbol.dispose]() {
    this.close();
  }
}

/**
 * Opens (creating if necessary) a SQLite-backed key-value store.
 * @param {string} [path] Filesystem path to the database file, or
 *   `':memory:'` for a non-persistent in-memory store. Defaults to
 *   `':memory:'`.
 * @param {{expireCheckIntervalMs?: number, queuePollIntervalMs?: number, queueVisibilityTimeoutMs?: number}} [options]
 * @returns {Promise<Store>}
 */
async function storageKV(path = ':memory:', options = {}) {
  const db = new DatabaseSync(path);
  schemaInit(db);
  return new Store(db, options);
}

module.exports = { Store, storageKV };
