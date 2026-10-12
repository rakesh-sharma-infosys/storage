'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testStoreOpen } = require('./helpers.js');

test('enqueue delivers a message to the queue listener', async () => {
  const store = await testStoreOpen({ queuePollIntervalMs: 5 });
  const received = [];
  store.listenQueue(async (v) => received.push(v));
  await store.enqueue({ job: 'send-email', to: 'a@example.com' });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(received, [{ job: 'send-email', to: 'a@example.com' }]);
  store.close();
});

test('multiple messages are delivered in FIFO order', async () => {
  const store = await testStoreOpen({ queuePollIntervalMs: 5 });
  const received = [];
  store.listenQueue(async (v) => received.push(v));
  await store.enqueue(1);
  await store.enqueue(2);
  await store.enqueue(3);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(received, [1, 2, 3]);
  store.close();
});

test('delay postpones delivery', async () => {
  const store = await testStoreOpen({ queuePollIntervalMs: 5 });
  const received = [];
  store.listenQueue(async (v) => received.push({ v, t: Date.now() }));
  const start = Date.now();
  await store.enqueue('delayed', { delay: 80 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(received.length, 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  assert.ok(received[0].t - start >= 70);
  store.close();
});

test('a failing handler retries according to the backoff schedule, then gives up', async () => {
  const store = await testStoreOpen({ queuePollIntervalMs: 5 });
  let attempts = 0;
  store.listenQueue(async () => {
    attempts++;
    throw new Error('always fails');
  });
  await store.enqueue('will-fail', { backoffSchedule: [5, 5] });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(attempts, 3); // 1 initial try + 2 retries
  store.close();
});

test('undelivered messages are written to keysIfUndelivered after retries are exhausted', async () => {
  const store = await testStoreOpen({ queuePollIntervalMs: 5 });
  store.listenQueue(async () => {
    throw new Error('always fails');
  });
  await store.enqueue(
    { payload: 'important' },
    { backoffSchedule: [5], keysIfUndelivered: [['dead-letters', 1]] }
  );
  await new Promise((r) => setTimeout(r, 100));
  const entry = await store.get(['dead-letters', 1]);
  assert.deepEqual(entry.value, { payload: 'important' });
  store.close();
});

test('a handler that eventually succeeds is not retried further', async () => {
  const store = await testStoreOpen({ queuePollIntervalMs: 5 });
  let attempts = 0;
  store.listenQueue(async () => {
    attempts++;
    if (attempts < 2) throw new Error('fail once');
  });
  await store.enqueue('eventually-ok', { backoffSchedule: [5, 5, 5] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(attempts, 2);
  // give it more time to make sure it doesn't get redelivered again
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(attempts, 2);
  store.close();
});

test('only one listenQueue handler may be active at a time', async () => {
  const store = await testStoreOpen({ queuePollIntervalMs: 5 });
  store.listenQueue(async () => {});
  assert.throws(() => store.listenQueue(async () => {}), /already active/);
  store.close();
});

test('listenQueue promise resolves when the Store is closed', async () => {
  const store = await testStoreOpen({ queuePollIntervalMs: 5 });
  const promise = store.listenQueue(async () => {});
  store.close();
  await promise;
});
