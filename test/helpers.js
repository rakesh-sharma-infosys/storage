'use strict';

const { storageKV } = require('../source/index.js');

/**
 * Opens an in-memory Store with background timers disabled by default, so
 * tests are deterministic unless they explicitly opt back in (e.g. queue
 * tests set `queuePollIntervalMs`).
 * @param {object} [options]
 * @returns {Promise<import('../source/database.js').Store>}
 */
function testStoreOpen(options = {}) {
  return storageKV(':memory:', {
    expireCheckIntervalMs: 0,
    queuePollIntervalMs: 0,
    ...options,
  });
}

module.exports = { testStoreOpen };
