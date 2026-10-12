'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testStoreOpen } = require('./helpers.js');
const { StoreU64 } = require('../source/index.js');

test('atomic commit applies all mutations together', async () => {
  const store = await testStoreOpen();
  const result = await store
    .atomic()
    .set(['a'], 1)
    .set(['b'], 2)
    .delete(['c'])
    .commit();
  assert.equal(result.ok, true);
  assert.equal((await store.get(['a'])).value, 1);
  assert.equal((await store.get(['b'])).value, 2);
  store.close();
});

test('atomic check succeeds when the version matches', async () => {
  const store = await testStoreOpen();
  const r1 = await store.set(['a'], 1);
  const r2 = await store
    .atomic()
    .check({ key: ['a'], version: r1.version })
    .set(['a'], 2)
    .commit();
  assert.equal(r2.ok, true);
  assert.equal((await store.get(['a'])).value, 2);
  store.close();
});

test('atomic check fails (and writes nothing) on a stale version', async () => {
  const store = await testStoreOpen();
  const r1 = await store.set(['a'], 1);
  await store.set(['a'], 2); // bump the version out from under r1
  const r2 = await store
    .atomic()
    .check({ key: ['a'], version: r1.version })
    .set(['a'], 3)
    .commit();
  assert.equal(r2.ok, false);
  assert.equal((await store.get(['a'])).value, 2);
  store.close();
});

test('atomic check with version: null requires the key to be absent', async () => {
  const store = await testStoreOpen();
  const r1 = await store
    .atomic()
    .check({ key: ['new'], version: null })
    .set(['new'], 'first')
    .commit();
  assert.equal(r1.ok, true);

  const r2 = await store
    .atomic()
    .check({ key: ['new'], version: null })
    .set(['new'], 'second')
    .commit();
  assert.equal(r2.ok, false);
  assert.equal((await store.get(['new'])).value, 'first');
  store.close();
});

test('a failed check rolls back every mutation in the same commit, not just the checked key', async () => {
  const store = await testStoreOpen();
  await store.set(['guard'], 'v1');
  const stale = 'ffffffff-ffff-7fff-bfff-ffffffffffff'; // never-matching version
  const result = await store
    .atomic()
    .check({ key: ['guard'], version: stale })
    .set(['side-effect'], 'should-not-exist')
    .commit();
  assert.equal(result.ok, false);
  assert.equal((await store.get(['side-effect'])).value, null);
  store.close();
});

test('sum treats a missing key as zero', async () => {
  const store = await testStoreOpen();
  await store.atomic().sum(['counter'], 5n).commit();
  const entry = await store.get(['counter']);
  assert.ok(entry.value instanceof StoreU64);
  assert.equal(entry.value.value, 5n);
  store.close();
});

test('sum accumulates across multiple commits', async () => {
  const store = await testStoreOpen();
  await store.atomic().sum(['counter'], 5n).commit();
  await store.atomic().sum(['counter'], 10n).commit();
  assert.equal((await store.get(['counter'])).value.value, 15n);
  store.close();
});

test('sum operand must be a non-negative bigint (StoreU64)', async () => {
  const store = await testStoreOpen();
  assert.throws(() => store.atomic().sum(['counter'], -3n), RangeError);
  store.close();
});

test('sum wraps on 64-bit overflow', async () => {
  const store = await testStoreOpen();
  const max = 2n ** 64n - 1n;
  await store.set(['counter'], new StoreU64(max));
  await store.atomic().sum(['counter'], 2n).commit();
  assert.equal((await store.get(['counter'])).value.value, 1n);
  store.close();
});

test('min and max update a StoreU64 correctly', async () => {
  const store = await testStoreOpen();
  await store.set(['k'], new StoreU64(50n));
  await store.atomic().min(['k'], 30n).commit();
  assert.equal((await store.get(['k'])).value.value, 30n);
  await store.atomic().max(['k'], 100n).commit();
  assert.equal((await store.get(['k'])).value.value, 100n);
  await store.atomic().max(['k'], 10n).commit();
  assert.equal((await store.get(['k'])).value.value, 100n);
  store.close();
});

test('sum/min/max reject a non-StoreU64 existing value', async () => {
  const store = await testStoreOpen();
  await store.set(['k'], 'not-a-u64');
  await assert.rejects(store.atomic().sum(['k'], 1n).commit(), TypeError);
  store.close();
});

test('mutate() object form behaves the same as the chained methods', async () => {
  const store = await testStoreOpen();
  await store.atomic().mutate({ type: 'set', key: ['a'], value: 1 }).commit();
  assert.equal((await store.get(['a'])).value, 1);
  await store.atomic().mutate({ type: 'delete', key: ['a'] }).commit();
  assert.equal((await store.get(['a'])).value, null);
  store.close();
});

test('enqueue can be batched into an atomic commit with other mutations', async () => {
  const store = await testStoreOpen({ queuePollIntervalMs: 5 });
  const received = [];
  store.listenQueue(async (v) => received.push(v));
  await store.atomic().set(['a'], 1).enqueue({ job: 'x' }).commit();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await store.get(['a'])).value, 1);
  assert.deepEqual(received, [{ job: 'x' }]);
  store.close();
});
