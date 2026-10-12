'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { storageKV } = require('../source/index.js');
const { testStoreOpen } = require('./helpers.js');

test('get on a missing key returns a null entry', async () => {
  const store = await testStoreOpen();
  const entry = await store.get(['missing']);
  assert.deepEqual(entry, { key: ['missing'], value: null, version: null });
  store.close();
});

test('set then get round-trips the value and returns a version', async () => {
  const store = await testStoreOpen();
  const result = await store.set(['a'], { n: 1 });
  assert.equal(result.ok, true);
  assert.match(result.version, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const entry = await store.get(['a']);
  assert.deepEqual(entry.value, { n: 1 });
  assert.equal(entry.version, result.version);
  store.close();
});

test('set overwrites an existing value and bumps the version', async () => {
  const store = await testStoreOpen();
  const r1 = await store.set(['a'], 1);
  const r2 = await store.set(['a'], 2);
  assert.notEqual(r1.version, r2.version);
  assert.ok(r2.version > r1.version);
  assert.equal((await store.get(['a'])).value, 2);
  store.close();
});

test('delete removes an entry', async () => {
  const store = await testStoreOpen();
  await store.set(['a'], 1);
  await store.delete(['a']);
  assert.deepEqual(await store.get(['a']), { key: ['a'], value: null, version: null });
  store.close();
});

test('delete on a missing key is a no-op', async () => {
  const store = await testStoreOpen();
  await assert.doesNotReject(store.delete(['missing']));
  store.close();
});

test('getMany returns entries (or null entries) in the requested order', async () => {
  const store = await testStoreOpen();
  await store.set(['a'], 1);
  await store.set(['b'], 2);
  const entries = await store.getMany([['a'], ['missing'], ['b']]);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].value, 1);
  assert.equal(entries[1].value, null);
  assert.equal(entries[2].value, 2);
  store.close();
});

test('supports multi-part keys with mixed part types', async () => {
  const store = await testStoreOpen();
  const key = ['users', 42, true, 7n, new Uint8Array([1, 2])];
  await store.set(key, 'mixed-key-value');
  const entry = await store.get(key);
  assert.equal(entry.value, 'mixed-key-value');
  store.close();
});

test('stores structured values: Map, Set, Date, nested objects', async () => {
  const store = await testStoreOpen();
  const value = {
    when: new Date('2024-06-01T00:00:00.000Z'),
    tags: new Set(['a', 'b']),
    meta: new Map([['x', 1]]),
    nested: { list: [1, 2, { deep: true }] },
  };
  await store.set(['doc'], value);
  const entry = await store.get(['doc']);
  assert.deepEqual(entry.value, value);
  store.close();
});

test('rejects invalid keys', async () => {
  const store = await testStoreOpen();
  await assert.rejects(store.get([]), TypeError);
  await assert.rejects(store.set(['a', null], 1), TypeError);
  await assert.rejects(store.set('not-an-array', 1), TypeError);
  store.close();
});

test('methods throw after close()', async () => {
  const store = await testStoreOpen();
  store.close();
  await assert.rejects(store.get(['a']));
  await assert.rejects(store.set(['a'], 1));
  assert.throws(() => store.atomic());
  assert.throws(() => store.list({ prefix: ['a'] }));
});

test('close() is idempotent', async () => {
  const store = await testStoreOpen();
  store.close();
  assert.doesNotThrow(() => store.close());
});

test('persists to a file and can be reopened', async (t) => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const dbPath = path.join(os.tmpdir(), `storage-kv-sqlite-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  const store1 = await storageKV(dbPath, { expireCheckIntervalMs: 0 });
  await store1.set(['persisted'], { ok: true });
  store1.close();

  const store2 = await storageKV(dbPath, { expireCheckIntervalMs: 0 });
  const entry = await store2.get(['persisted']);
  assert.deepEqual(entry.value, { ok: true });
  store2.close();
});
