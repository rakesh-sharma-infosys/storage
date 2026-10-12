'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testStoreOpen } = require('./helpers.js');

test('a key without expireIn never expires', async () => {
  const store = await testStoreOpen();
  await store.set(['a'], 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await store.get(['a'])).value, 1);
  store.close();
});

test('a key with expireIn is readable before expiry and gone after', async () => {
  const store = await testStoreOpen();
  await store.set(['a'], 'temp', { expireIn: 20 });
  assert.equal((await store.get(['a'])).value, 'temp');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await store.get(['a']), { key: ['a'], value: null, version: null });
  store.close();
});

test('expired keys are excluded from getMany', async () => {
  const store = await testStoreOpen();
  await store.set(['a'], 'temp', { expireIn: 10 });
  await store.set(['b'], 'keep');
  await new Promise((r) => setTimeout(r, 30));
  const [a, b] = await store.getMany([['a'], ['b']]);
  assert.equal(a.value, null);
  assert.equal(b.value, 'keep');
  store.close();
});

test('overwriting a key clears its previous expiration', async () => {
  const store = await testStoreOpen();
  await store.set(['a'], 'temp', { expireIn: 20 });
  await store.set(['a'], 'permanent');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await store.get(['a'])).value, 'permanent');
  store.close();
});

test('background sweep physically removes expired rows', async () => {
  const store = await testStoreOpen({ expireCheckIntervalMs: 20 });
  await store.set(['a'], 'temp', { expireIn: 10 });
  await new Promise((r) => setTimeout(r, 80));
  const row = store._db.prepare('SELECT COUNT(*) as n FROM entries').get();
  assert.equal(Number(row.n), 0);
  store.close();
});
