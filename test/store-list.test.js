'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testStoreOpen } = require('./helpers.js');

async function usersSeed(store, n) {
  for (let i = 1; i <= n; i++) {
    await store.set(['users', i], { id: i });
  }
}

async function collect(iter) {
  const out = [];
  for await (const entry of iter) out.push(entry);
  return out;
}

test('list by prefix returns matching entries in key order', async () => {
  const store = await testStoreOpen();
  await usersSeed(store, 5);
  await store.set(['posts', 1], { id: 1 });
  const entries = await collect(store.list({ prefix: ['users'] }));
  assert.deepEqual(entries.map((e) => e.key), [
    ['users', 1],
    ['users', 2],
    ['users', 3],
    ['users', 4],
    ['users', 5],
  ]);
  store.close();
});

test('list prefix excludes keys outside the prefix, including similar prefixes', async () => {
  const store = await testStoreOpen();
  await store.set(['user'], 'a');
  await store.set(['users'], 'b');
  await store.set(['users', 1], 'c');
  await store.set(['userz'], 'd');
  const entries = await collect(store.list({ prefix: ['users'] }));
  assert.deepEqual(entries.map((e) => e.key), [['users'], ['users', 1]]);
  store.close();
});

test('list respects reverse order', async () => {
  const store = await testStoreOpen();
  await usersSeed(store, 3);
  const entries = await collect(store.list({ prefix: ['users'] }, { reverse: true }));
  assert.deepEqual(entries.map((e) => e.key[1]), [3, 2, 1]);
  store.close();
});

test('list respects limit', async () => {
  const store = await testStoreOpen();
  await usersSeed(store, 10);
  const entries = await collect(store.list({ prefix: ['users'] }, { limit: 3 }));
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.key[1]), [1, 2, 3]);
  store.close();
});

test('list limit works together with reverse', async () => {
  const store = await testStoreOpen();
  await usersSeed(store, 10);
  const entries = await collect(store.list({ prefix: ['users'] }, { reverse: true, limit: 3 }));
  assert.deepEqual(entries.map((e) => e.key[1]), [10, 9, 8]);
  store.close();
});

test('cursor resumes listing after the last yielded entry', async () => {
  const store = await testStoreOpen();
  await usersSeed(store, 10);

  const it1 = store.list({ prefix: ['users'] }, { limit: 4 });
  const page1 = await collect(it1);
  assert.deepEqual(page1.map((e) => e.key[1]), [1, 2, 3, 4]);
  assert.ok(it1.cursor);

  const page2 = await collect(store.list({ prefix: ['users'] }, { cursor: it1.cursor }));
  assert.deepEqual(page2.map((e) => e.key[1]), [5, 6, 7, 8, 9, 10]);
  store.close();
});

test('cursor resumes correctly in reverse mode', async () => {
  const store = await testStoreOpen();
  await usersSeed(store, 6);

  const it1 = store.list({ prefix: ['users'] }, { reverse: true, limit: 2 });
  const page1 = await collect(it1);
  assert.deepEqual(page1.map((e) => e.key[1]), [6, 5]);

  const page2 = await collect(store.list({ prefix: ['users'] }, { reverse: true, cursor: it1.cursor }));
  assert.deepEqual(page2.map((e) => e.key[1]), [4, 3, 2, 1]);
  store.close();
});

test('list with start/end range (no prefix) across different key shapes', async () => {
  const store = await testStoreOpen();
  await store.set(['a'], 1);
  await store.set(['m'], 2);
  await store.set(['z'], 3);
  const entries = await collect(store.list({ start: ['a'], end: ['z'] }));
  // end is exclusive
  assert.deepEqual(entries.map((e) => e.key), [['a'], ['m']]);
  store.close();
});

test('list with prefix + start sub-range', async () => {
  const store = await testStoreOpen();
  await usersSeed(store, 10);
  const entries = await collect(store.list({ prefix: ['users'], start: ['users', 5] }));
  assert.deepEqual(entries.map((e) => e.key[1]), [5, 6, 7, 8, 9, 10]);
  store.close();
});

test('list with prefix + end sub-range', async () => {
  const store = await testStoreOpen();
  await usersSeed(store, 10);
  const entries = await collect(store.list({ prefix: ['users'], end: ['users', 5] }));
  assert.deepEqual(entries.map((e) => e.key[1]), [1, 2, 3, 4]);
  store.close();
});

test('list over an empty range yields nothing', async () => {
  const store = await testStoreOpen();
  const entries = await collect(store.list({ prefix: ['nothing-here'] }));
  assert.deepEqual(entries, []);
  store.close();
});

test('list excludes expired entries', async () => {
  const store = await testStoreOpen();
  await store.set(['users', 1], 'a', { expireIn: 10 });
  await store.set(['users', 2], 'b');
  await new Promise((r) => setTimeout(r, 30));
  const entries = await collect(store.list({ prefix: ['users'] }));
  assert.deepEqual(entries.map((e) => e.key[1]), [2]);
  store.close();
});

test('list requires a valid selector', async () => {
  const store = await testStoreOpen();
  assert.throws(() => store.list({}), TypeError);
  assert.throws(() => store.list({ start: ['a'] }), TypeError);
  store.close();
});

test('list works across a large range with small batchSize (pagination correctness)', async () => {
  const store = await testStoreOpen();
  await usersSeed(store, 250);
  const entries = await collect(store.list({ prefix: ['users'] }, { batchSize: 7 }));
  assert.equal(entries.length, 250);
  assert.deepEqual(entries.map((e) => e.key[1]).slice(0, 5), [1, 2, 3, 4, 5]);
  assert.equal(entries.at(-1).key[1], 250);
  store.close();
});
