'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testStoreOpen } = require('./helpers.js');

test('watch immediately yields the current state of the watched keys', async () => {
  const store = await testStoreOpen();
  await store.set(['a'], 'initial');
  const watcher = store.watch([['a'], ['b']]);
  const first = (await watcher.next()).value;
  assert.deepEqual(
    first.map((e) => e.value),
    ['initial', null]
  );
  await watcher.return();
  store.close();
});

test('watch yields a new snapshot after a relevant commit', async () => {
  const store = await testStoreOpen();
  const watcher = store.watch([['a']]);
  await watcher.next(); // initial snapshot
  await store.set(['a'], 'updated');
  const next = (await watcher.next()).value;
  assert.equal(next[0].value, 'updated');
  await watcher.return();
  store.close();
});

test('watch via for-await-of observes multiple updates in order', async () => {
  const store = await testStoreOpen();
  const seen = [];
  const watcher = store.watch([['counter']]);

  const consumer = (async () => {
    for await (const snapshot of watcher) {
      seen.push(snapshot[0].value);
      if (seen.length >= 3) break;
    }
  })();

  await new Promise((r) => setTimeout(r, 10));
  await store.set(['counter'], 1);
  await store.set(['counter'], 2);
  await consumer;
  assert.deepEqual(seen, [null, 1, 2]);
  store.close();
});

test('watch stops yielding after return() is called', async () => {
  const store = await testStoreOpen();
  const watcher = store.watch([['a']]);
  await watcher.next();
  await watcher.return();
  await store.set(['a'], 'after-close');
  const result = await watcher.next();
  assert.equal(result.done, true);
  store.close();
});

test('closing the Store does not hang a pending watch (sanity: no unhandled timers)', async () => {
  const store = await testStoreOpen();
  const watcher = store.watch([['a']]);
  await watcher.next();
  await watcher.return();
  store.close();
});
