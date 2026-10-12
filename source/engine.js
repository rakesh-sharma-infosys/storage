'use strict';

const { keyEncode, keyDecode } = require('./key.js');
const { valueEncode, valueDecode, StoreU64 } = require('./value.js');
const { versionNext } = require('./version.js');

/**
 * Default retry delays (ms) applied between queue delivery attempts when an
 * `enqueue()` call does not supply its own `backoffSchedule`. The array
 * length plus one is the total number of delivery attempts before a message
 * is considered undelivered.
 * @type {number[]}
 */
const DEFAULT_BACKOFF_SCHEDULE = [100, 1000, 5000, 30000];

/**
 * @fileoverview Synchronous storage engine shared by the public `Store` API
 * and `AtomicOperation`. Every multi-statement operation (including a plain
 * `store.set()`) is funneled through {@link SqliteTransactionEngine#commit} so there is a
 * single code path that applies checks and mutations transactionally.
 *
 * All methods here are synchronous. node:sqlite's `DatabaseSync` is
 * synchronous, and because Node.js is single-threaded, as long as a
 * transaction never awaits in the middle, no other operation can interleave
 * with it — this is what makes `commit()` atomic without any extra locking.
 */

class SqliteTransactionEngine {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   */
  constructor(db) {
    this.db = db;
    this._stmts = {
      entryGet: db.prepare('SELECT value, version, expires_at FROM entries WHERE key = ?'),
      entrySet: db.prepare(
        'INSERT INTO entries (key, value, version, expires_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = excluded.version, expires_at = excluded.expires_at'
      ),
      entryDelete: db.prepare('DELETE FROM entries WHERE key = ?'),
      expiredSweep: db.prepare('DELETE FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?'),
      enqueue: db.prepare(
        'INSERT INTO queue (value, enqueued_at, available_at, max_attempts, backoff_schedule, keys_if_undelivered) ' +
          'VALUES (?, ?, ?, ?, ?, ?)'
      ),
    };
  }

  /**
   * Allocates the (UUIDv7) version for the commit currently in progress.
   * @returns {string}
   */
  versionNext() {
    return versionNext();
  }

  /**
   * Deletes all expired rows as of `now`.
   * @param {number} now epoch ms
   * @returns {number} rows removed
   */
  expiredSweep(now) {
    const result = this._stmts.expiredSweep.run(now);
    return Number(result.changes);
  }

  /**
   * Reads a single entry by its decoded key parts.
   * @param {Array} key
   * @param {number} now epoch ms, used to hide (but not yet delete) expired rows
   * @returns {{key: Array, value: unknown, version: string}|null}
   */
  entryGet(key, now) {
    const encoded = keyEncode(key);
    const row = this._stmts.entryGet.get(encoded);
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= now) return null;
    return { key, value: valueDecode(row.value), version: row.version };
  }

  /**
   * Reads the raw (encoded) current state of a key, used by atomic `check`.
   * @param {Buffer} encodedKey
   * @param {number} now
   * @returns {{version: string}|null}
   */
  versionRawGet(encodedKey, now) {
    const row = this._stmts.entryGet.get(encodedKey);
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= now) return null;
    return { version: row.version };
  }

  /**
   * Range scan between encoded byte bounds.
   * @param {object} opts
   * @param {Buffer} opts.lower inclusive lower bound
   * @param {Buffer|null} opts.upper exclusive upper bound, or null for unbounded
   * @param {boolean} opts.reverse
   * @param {number|undefined} opts.limit
   * @param {Buffer|null} opts.cursorKey exclusive cursor boundary, or null
   * @param {number} opts.now epoch ms
   * @returns {Array<{key: Array, value: unknown, version: string}>}
   */
  range({ lower, upper, reverse, limit, cursorKey, now }) {
    const clauses = ['key >= ?'];
    const params = [lower];
    if (upper) {
      clauses.push('key < ?');
      params.push(upper);
    }
    clauses.push('(expires_at IS NULL OR expires_at > ?)');
    params.push(now);
    if (cursorKey) {
      clauses.push(reverse ? 'key < ?' : 'key > ?');
      params.push(cursorKey);
    }
    let sql = `SELECT key, value, version FROM entries WHERE ${clauses.join(' AND ')} ORDER BY key ${
      reverse ? 'DESC' : 'ASC'
    }`;
    if (typeof limit === 'number') {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map((row) => ({
      key: keyDecode(row.key),
      value: valueDecode(row.value),
      version: row.version,
    }));
  }

  /**
   * Applies a single mutation inside the current transaction. Must only be
   * called from within {@link SqliteTransactionEngine#commit}.
   * @param {object} mutation
   * @param {string} version
   * @param {number} now
   */
  _mutationApply(mutation, version, now) {
    if (mutation.type === 'set') {
      const encoded = keyEncode(mutation.key);
      const expiresAt =
        typeof mutation.expireIn === 'number' ? now + mutation.expireIn : null;
      this._stmts.entrySet.run(encoded, valueEncode(mutation.value), version, expiresAt);
      return;
    }
    if (mutation.type === 'delete') {
      this._stmts.entryDelete.run(keyEncode(mutation.key));
      return;
    }
    if (mutation.type === 'sum' || mutation.type === 'min' || mutation.type === 'max') {
      const encoded = keyEncode(mutation.key);
      const row = this._stmts.entryGet.get(encoded);
      let current = 0n;
      if (row && (row.expires_at === null || row.expires_at > now)) {
        const decoded = valueDecode(row.value);
        if (!(decoded instanceof StoreU64)) {
          throw new TypeError(
            `cannot apply '${mutation.type}' mutation: existing value at key is not a StoreU64`
          );
        }
        current = decoded.value;
      }
      const operand = mutation.value.value;
      let next;
      if (mutation.type === 'sum') {
        next = BigInt.asUintN(64, current + operand);
      } else if (mutation.type === 'min') {
        next = current < operand ? current : operand;
      } else {
        next = current > operand ? current : operand;
      }
      this._stmts.entrySet.run(encoded, valueEncode(new StoreU64(next)), version, null);
      return;
    }
    if (mutation.type === 'enqueue') {
      const delay = typeof mutation.delay === 'number' ? mutation.delay : 0;
      const backoffSchedule = mutation.backoffSchedule || DEFAULT_BACKOFF_SCHEDULE;
      this._stmts.enqueue.run(
        valueEncode(mutation.value),
        now,
        now + delay,
        backoffSchedule.length + 1,
        JSON.stringify(backoffSchedule),
        mutation.keysIfUndelivered && mutation.keysIfUndelivered.length
          ? JSON.stringify(mutation.keysIfUndelivered.map((k) => keyEncode(k).toString('base64')))
          : null
      );
      return;
    }
    throw new TypeError(`unknown mutation type: ${mutation.type}`);
  }

  /**
   * Runs `checks` then `mutations` inside a single transaction. Returns the
   * commit's version, or `null` if any check failed (in which case the
   * transaction is rolled back and nothing is written).
   * @param {Array<{key: Array, version: string|null}>} checks
   * @param {Array<object>} mutations
   * @param {number} [now]
   * @returns {string|null}
   */
  commit(checks, mutations, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const check of checks) {
        const encoded = keyEncode(check.key);
        const current = this.versionRawGet(encoded, now);
        const currentVersion = current ? current.version : null;
        if (currentVersion !== check.version) {
          this.db.exec('ROLLBACK');
          return null;
        }
      }
      const version = this.versionNext();
      for (const mutation of mutations) {
        this._mutationApply(mutation, version, now);
      }
      this.db.exec('COMMIT');
      return version;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

module.exports = { SqliteTransactionEngine, DEFAULT_BACKOFF_SCHEDULE };
