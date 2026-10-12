# storage-kv-sqlite

A Node.js key-value store built on the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html)
module, with a simple, promise-based key-value API.

- Zero external dependencies (only Node.js built-ins).
- CommonJS (`require`). 
- Needs a Node.js version with `node:sqlite`
  (>= 24; `package.json` declares `>=24`, which is what it is tested on).
- Hierarchical keys, TTLs, atomic transactions with optimistic concurrency,
  64-bit counters, prefix/range listing with cursors, a persistent queue and
  key watching.
- See [DESIGN.md](DESIGN.md) for key/value encoding details and design notes.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [API reference](#api-reference)
  - [`storageKV()`](#storagekvpath-options)
  - [`Store` methods](#store-instance-methods): [`get`](#storegetkey-options), [`getMany`](#storegetmanykeys-options), [`set`](#storesetkey-value-options), [`delete`](#storedeletekey), [`list`](#storelistselector-options), [`atomic`](#storeatomic), [`enqueue`](#storeenqueuevalue-options), [`listenQueue`](#storelistenqueuehandler), [`watch`](#storewatchkeys), [`close`](#storeclose)
  - [`AtomicOperation` methods](#atomicoperation)
  - [`StoreListIterator`](#storelistiterator)
  - [`StoreU64`](#storeu64)
- [Recipes](#recipes)
- [Errors](#errors)
- [Limitations](#limitations)
- [Scripts](#scripts)

## Install

This is a local package (no registry publish). Use it via a relative
`require`/path dependency.

## Quick start

```js
const { storageKV, StoreU64 } = require('storage-kv-sqlite');

(async () => {
  const store = await storageKV('./data.db'); // or storageKV() for an in-memory store

  await store.set(['users', 1], { name: 'Ada', role: 'admin' });
  const entry = await store.get(['users', 1]);
  console.log(entry.value); // { name: 'Ada', role: 'admin' }

  for await (const e of store.list({ prefix: ['users'] })) {
    console.log(e.key, e.value);
  }

  // Optimistic concurrency.
  await store
    .atomic()
    .check({ key: ['users', 1], version: entry.version })
    .set(['users', 1], { ...entry.value, role: 'owner' })
    .commit();

  // Atomic counters.
  await store.set(['views'], new StoreU64(0n));
  await store.atomic().sum(['views'], 1n).commit();

  store.close();
})();
```

## Concepts

**Keys** are non-empty arrays of parts. A part is a `string`, `number`
(not `NaN`), `bigint` (signed 64-bit range), `boolean` or `Uint8Array`.
Keys sort part by part; across types the order is
`Uint8Array < string < bigint < number < boolean`. A shorter key sorts before
longer keys that extend it.

```js
['users', 42]            // fine
['logs', 2024n, true]    // mixed types are fine
[]                       // TypeError: at least one part required
['a', NaN]               // TypeError: invalid key part
```

**Values** can be anything the V8 structured-clone serializer supports:
objects, arrays, `Map`, `Set`, `Date`, `RegExp`, typed arrays, `bigint`,
primitives, `null`. Functions are rejected. `StoreU64` is stored specially (see
[`StoreU64`](#storeu64)).

**Entries** returned from reads look like `{ key, value, version }`. A missing
(or expired) key yields `{ key, value: null, version: null }`; it never throws.

**Versions** are UUIDv7 strings (e.g. `01a13068-6599-7943-9394-c8b76c0ec0fa`,
generated with Node's native `crypto.randomUUIDv7()`) that increase with every
commit and sort lexicographically in commit order. Use them with
`atomic().check()` for optimistic concurrency.

## API reference

### `storageKV(path?, options?)`

`async function storageKV(path = ':memory:', options = {}) => Promise<Store>`

Opens (creating if needed) a database and returns a [`Store`](#store-instance-methods).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | `':memory:'` | Database file path, or `':memory:'` for a non-persistent store. |
| `options.expireCheckIntervalMs` | `number` | `30000` | How often expired rows are physically deleted. `0` disables the sweep. Expired entries are never *returned* regardless of this setting. |
| `options.queuePollIntervalMs` | `number` | `50` | How often the queue listener polls for due messages. |
| `options.queueVisibilityTimeoutMs` | `number` | `30000` | How long a claimed message stays hidden while its handler runs. If the handler runs longer, the message may be redelivered. |

```js
const { storageKV } = require('storage-kv-sqlite');

const mem = await storageKV();                          // in-memory
const db  = await storageKV('./app.db');                // file-backed
const t   = await storageKV('./t.db', { expireCheckIntervalMs: 0 }); // no sweeper
```

### `Store` instance methods

#### `store.get(key, options?)`

`Promise<StoreEntry | StoreEmptyEntry>` — reads one key. `options.consistency`
(`'strong' | 'eventual'`) is accepted but has no effect; reads are always
strongly consistent.

```js
const hit  = await store.get(['users', 1]);
// { key: ['users', 1], value: { name: 'Ada' }, version: '01a13068-6599-7943-9394-c8b76c0ec0fa' }
const miss = await store.get(['users', 999]);
// { key: ['users', 999], value: null, version: null }
```

#### `store.getMany(keys, options?)`

`Promise<Array<StoreEntry | StoreEmptyEntry>>` — reads several keys in one call.
Results are returned in the same order as `keys`.

```js
const [a, b] = await store.getMany([['users', 1], ['users', 2]]);
```

#### `store.set(key, value, options?)`

`Promise<{ ok: true, version: string }>` — writes `value`, replacing any
existing entry.

| Option | Type | Description |
|---|---|---|
| `expireIn` | `number` (ms) | Relative TTL. After this time the entry reads as absent. |

```js
await store.set(['config', 'theme'], 'dark');
await store.set(['session', token], { userId: 1 }, { expireIn: 60 * 60 * 1000 }); // 1 hour
```

#### `store.delete(key)`

`Promise<void>` — removes the entry. Deleting a missing key is a no-op.

```js
await store.delete(['session', token]);
```

#### `store.list(selector, options?)`

Returns a [`StoreListIterator`](#storelistiterator) (synchronously) over entries
ordered by key.

**Selector** — one of:

| Selector | Meaning |
|---|---|
| `{ prefix }` | All keys that start with `prefix`. |
| `{ prefix, start }` | Keys under `prefix`, from `start` (inclusive). |
| `{ prefix, end }` | Keys under `prefix`, up to `end` (exclusive). |
| `{ start, end }` | An arbitrary range, `start` inclusive, `end` exclusive. |

Anything else (e.g. only `start`) throws a `TypeError`.

**Options**

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | unlimited | Maximum number of entries to yield. |
| `reverse` | `boolean` | `false` | Iterate in descending key order. |
| `cursor` | `string` | – | Resume after the position encoded in a previous iterator's `.cursor`. |
| `batchSize` | `number` | `100` | Rows fetched per SQL page. Affects I/O only, not results. |

```js
// Everything under ['users']
for await (const { key, value } of store.list({ prefix: ['users'] })) { /* ... */ }

// Newest 10 events
const latest = [];
for await (const e of store.list({ prefix: ['events'] }, { reverse: true, limit: 10 })) {
  latest.push(e);
}

// Explicit range: ['users', 10] <= key < ['users', 20]
store.list({ start: ['users', 10], end: ['users', 20] });

// Collect into an array
const all = await Array.fromAsync(store.list({ prefix: ['users'] }));
```

#### `store.atomic()`

Returns a new [`AtomicOperation`](#atomicoperation) builder.

#### `store.enqueue(value, options?)`

`Promise<{ ok: true, version: string }>` — adds a message to the queue.

| Option | Type | Default | Description |
|---|---|---|---|
| `delay` | `number` (ms) | `0` | Don't deliver before this delay has elapsed. |
| `backoffSchedule` | `number[]` (ms) | `[100, 1000, 5000, 30000]` | Delays between retries after handler failures. Total attempts = length + 1. |
| `keysIfUndelivered` | `StoreKey[]` | – | If all attempts fail, `value` is written to each of these keys. |

```js
await store.enqueue({ type: 'email', to: 'a@example.com' });
await store.enqueue({ type: 'reminder' }, {
  delay: 5000,
  backoffSchedule: [1000, 5000],
  keysIfUndelivered: [['failed', 'reminder', 1]],
});
```

#### `store.listenQueue(handler)`

`Promise<void>` — starts polling and calls `handler(value)` for each message,
oldest first. Only one listener per `Store` instance (a second call throws). The
returned promise resolves when the `Store` is closed, and the active listener
keeps the process alive.

Delivery is at-least-once: if `handler` throws or rejects, the message is
retried per its `backoffSchedule`; after the last attempt it is written to
`keysIfUndelivered` (if given) and dropped.

```js
store.listenQueue(async (msg) => {
  if (msg.type === 'email') await sendEmail(msg.to);
}); // don't await unless you want to block until close()

await store.enqueue({ type: 'email', to: 'a@example.com' });
```

#### `store.watch(keys)`

Returns an `AsyncIterableIterator<Array<StoreEntry | StoreEmptyEntry>>`. It yields
the current state of `keys` immediately, then again after every commit on this
`Store` instance (the snapshot is re-read each time, so it may be unchanged).
Call `.return()` or `break` out of `for await` to stop.

```js
for await (const [counter, flag] of store.watch([['counter'], ['flag']])) {
  console.log(counter.value, flag.value);
  if (counter.value?.value >= 3n) break; // StoreU64 -> .value is a bigint
}
```

Only changes made through this `Store` instance are observed, not other processes.

#### `store.close()`

Closes the database and stops timers, the queue listener and watchers.
Idempotent. Any other method throws afterwards
(`this Store instance has been closed`). `store[Symbol.dispose]()` does the same,
so `using store = await storageKV('./x.db')` works where explicit resource management is
available.

### `AtomicOperation`

Created by `store.atomic()`. All builder methods return `this` for chaining.
Nothing happens until `commit()`, which applies all checks and mutations in one
SQLite transaction.

| Method | Description |
|---|---|
| `check(...{ key, version })` | Require `key`'s current version to equal `version`. `version: null` means the key must not exist. |
| `set(key, value, options?)` | Queue a write (`options.expireIn` in ms). |
| `delete(key)` | Queue a delete. |
| `sum(key, n)` | Add bigint `n` to the `StoreU64` at `key` (missing = 0), wrapping at 2^64. |
| `min(key, n)` | Set `StoreU64` at `key` to `min(current, n)`; missing key becomes `n`. |
| `max(key, n)` | Set `StoreU64` at `key` to `max(current, n)`; missing key becomes `n`. |
| `enqueue(value, options?)` | Queue a message as part of the same transaction (same options as `store.enqueue`). |
| `mutate(...mutations)` | Object form: `{ type: 'set'|'delete'|'sum'|'min'|'max', key, value?, options? }`. For `sum`/`min`/`max`, `value` is a `StoreU64`. |
| `commit()` | `Promise<{ ok: true, version } \| { ok: false }>`. On `ok: false` a check failed and nothing was written. |

```js
// Create only if absent
const res = await store.atomic()
  .check({ key: ['users', 'ada'], version: null })
  .set(['users', 'ada'], { name: 'Ada' })
  .commit();
if (!res.ok) console.log('already exists');

// Transfer between accounts with optimistic concurrency
const [from, to] = await store.getMany([['acct', 'a'], ['acct', 'b']]);
await store.atomic()
  .check(from, to) // entries have { key, version }
  .set(['acct', 'a'], from.value - 10)
  .set(['acct', 'b'], to.value + 10)
  .commit();

// Counters
await store.atomic()
  .sum(['stats', 'hits'], 1n)
  .max(['stats', 'peak'], 250n)
  .min(['stats', 'fastest'], 12n)
  .commit();

// Object form
await store.atomic().mutate(
  { type: 'set', key: ['a'], value: 1 },
  { type: 'delete', key: ['b'] },
  { type: 'sum', key: ['n'], value: new StoreU64(5n) },
).commit();
```

### `StoreListIterator`

Returned by `store.list()`. An async iterator (use `for await...of`) that
fetches lazily in pages of `batchSize`.

| Member | Description |
|---|---|
| `next()` | Standard async-iterator `next()`. |
| `[Symbol.asyncIterator]()` | Returns itself. |
| `cursor` | Opaque string positioned just after the last yielded entry (`''` before any entry, unless a cursor was supplied). |

Pagination across calls:

```js
async function page(cursor) {
  const it = store.list({ prefix: ['posts'] }, { limit: 20, cursor });
  const items = await Array.fromAsync(it);
  return { items, next: items.length === 20 ? it.cursor : null };
}

let { items, next } = await page();
while (next) ({ items, next } = await page(next));
```

### `StoreU64`

`new StoreU64(value: bigint)` — immutable unsigned 64-bit integer, range
`[0, 2^64 - 1]` (throws `TypeError` for non-bigint, `RangeError` out of range).
Read it via `.value`. Use it to initialize or overwrite counters; `sum`, `min`
and `max` operate on it.

```js
await store.set(['counter'], new StoreU64(0n));
await store.atomic().sum(['counter'], 5n).commit();
const { value } = await store.get(['counter']);
console.log(value instanceof StoreU64, value.value); // true 5n
```

### Other exports

`require('storage-kv-sqlite')` also exports the classes `Store`, `AtomicOperation` and
`StoreListIterator`, mainly for `instanceof` checks and typing. Create instances
via `storageKV()`, `store.atomic()` and `store.list()` rather than their constructors.

## Recipes

**Secondary index** — write the record and its index entry together:

```js
await store.atomic()
  .set(['users', id], user)
  .set(['users_by_email', user.email], id)
  .commit();
const { value: id } = await store.get(['users_by_email', 'ada@example.com']);
```

**Retry loop for read-modify-write:**

```js
let ok = false;
while (!ok) {
  const e = await store.get(['doc']);
  ({ ok } = await store.atomic()
    .check(e)
    .set(['doc'], { ...e.value, edits: (e.value?.edits ?? 0) + 1 })
    .commit());
}
```

**Expiring cache entry:**

```js
await store.set(['cache', url], body, { expireIn: 30_000 });
```

**Enqueue only if a write succeeds:**

```js
await store.atomic()
  .set(['orders', id], order)
  .enqueue({ type: 'order-created', id })
  .commit();
```

## Errors

| Error | When |
|---|---|
| `TypeError` | Invalid key (not an array, empty, bad part, `NaN`), bad `check` version, non-bigint operand to `sum`/`min`/`max`, bad `list` selector, unknown `mutate` type. |
| `RangeError` | `bigint` key part outside signed 64-bit, `StoreU64` outside `[0, 2^64-1]`. |
| `Error` | Using a closed `Store`; calling `listenQueue` twice; unserializable value (e.g. a function). |

A failed `atomic().commit()` check is **not** an error; it resolves to `{ ok: false }`.

## Limitations

- Requires Node.js >= 24 (`crypto.randomUUIDv7`).
- Versions are strictly increasing per process; across processes or after a
  clock step backwards they are unique but only approximately time-ordered.
  They are only ever compared for equality by `check()`.
- Single process: queue delivery and `watch()` only observe this instance's activity.
- `bigint` key parts are limited to the signed 64-bit range.
- `watch()` returns a plain async iterator, not a `ReadableStream`.
- No `commitVersion()` sentinel; `consistency` read option is a no-op.
- Queue delivery is at-least-once, not exactly-once.

## Scripts

```
npm test          # run the unit test suite (node:test)
npm run bench     # run the real-world benchmark / performance test
npm run test:perf # insert 1,000,000 records into a file-backed database
```

CI (`.github/workflows/ci.yml`) runs syntax checks, the unit tests and a reduced
perf test on every push to `main`.
