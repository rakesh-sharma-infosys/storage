'use strict';

/**
 * @fileoverview Performance tests: insert 1,000,000 records into a
 * file-backed database. Kept out of `test/` so the regular `npm test` stays
 * fast; run with `npm run test:perf`.
 *
 * Override the record count with `PERF_RECORDS` (default 1,000,000).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { storageKV } = require('../source/index.js');

const TOTAL = Number(process.env.PERF_RECORDS) || 1_000_000;
const BATCH = 1_000;
const TIMEOUT_MS = 30 * 60 * 1000;

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-kv-sqlite-perf-'));
  return { dir, file: path.join(dir, 'perf.db') };
}

function report(label, count, ms) {
  console.log(
    `  ${label}: ${count.toLocaleString('en-US')} records in ${(ms / 1000).toFixed(2)}s` +
      ` => ${Math.round(count / (ms / 1000)).toLocaleString('en-US')} records/sec`
  );
}

async function countEntries(store, prefix) {
  let n = 0;
  for await (const _ of store.list({ prefix, batchSize: 5000 })) n++;
  return n;
}

test('inserts 1M records on disk using batched atomic commits', { timeout: TIMEOUT_MS }, async () => {
  const { dir, file } = tempDbPath();
  const store = await storageKV(file, { expireCheckIntervalMs: 0, queuePollIntervalMs: 0 });
  try {
    const start = process.hrtime.bigint();
    for (let base = 0; base < TOTAL; base += BATCH) {
      const op = store.atomic();
      const end = Math.min(base + BATCH, TOTAL);
      for (let i = base; i < end; i++) {
        op.set(['bulk', i], { id: i, name: `record-${i}` });
      }
      const res = await op.commit();
      assert.equal(res.ok, true);
    }
    report('atomic batches of ' + BATCH, TOTAL, Number(process.hrtime.bigint() - start) / 1e6);

    assert.equal(await countEntries(store, ['bulk']), TOTAL);
    assert.deepEqual((await store.get(['bulk', 0])).value, { id: 0, name: 'record-0' });
    const last = TOTAL - 1;
    assert.deepEqual((await store.get(['bulk', last])).value, { id: last, name: `record-${last}` });
    assert.ok(fs.statSync(file).size > 0, 'database file exists on disk');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inserts 1M records on disk using individual set() calls', { timeout: TIMEOUT_MS }, async () => {
  const { dir, file } = tempDbPath();
  const store = await storageKV(file, { expireCheckIntervalMs: 0, queuePollIntervalMs: 0 });
  try {
    const start = process.hrtime.bigint();
    for (let i = 0; i < TOTAL; i++) {
      await store.set(['single', i], { id: i });
    }
    report('sequential set()', TOTAL, Number(process.hrtime.bigint() - start) / 1e6);

    assert.equal(await countEntries(store, ['single']), TOTAL);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('1M records persist across close and reopen', { timeout: TIMEOUT_MS }, async () => {
  const { dir, file } = tempDbPath();
  try {
    const store1 = await storageKV(file, { expireCheckIntervalMs: 0, queuePollIntervalMs: 0 });
    for (let base = 0; base < TOTAL; base += BATCH) {
      const op = store1.atomic();
      for (let i = base; i < Math.min(base + BATCH, TOTAL); i++) op.set(['p', i], i);
      await op.commit();
    }
    store1.close();

    const start = process.hrtime.bigint();
    const store2 = await storageKV(file, { expireCheckIntervalMs: 0, queuePollIntervalMs: 0 });
    try {
      assert.equal(await countEntries(store2, ['p']), TOTAL);
      report('reopen + full scan', TOTAL, Number(process.hrtime.bigint() - start) / 1e6);
      assert.equal((await store2.get(['p', TOTAL >> 1])).value, TOTAL >> 1);
    } finally {
      store2.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
