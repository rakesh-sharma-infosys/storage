'use strict';

/**
 * @fileoverview Public entry point for storage-kv-sqlite: a Node.js key-value
 * store built on `node:sqlite`, with a key-value API.
 *
 * @example
 * const { storageKV } = require('storage-kv-sqlite');
 *
 * const store = await storageKV('./data.db');
 * await store.set(['users', 1], { name: 'Ada' });
 * const entry = await store.get(['users', 1]);
 * store.close();
 */

const { Store, storageKV } = require('./database.js');
const { AtomicOperation } = require('./atomic.js');
const { StoreU64 } = require('./value.js');
const { StoreListIterator } = require('./list.js');

module.exports = {
  storageKV,
  Store,
  AtomicOperation,
  StoreU64,
  StoreListIterator,
};
