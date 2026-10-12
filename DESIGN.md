# storage-kv-sqlite — Design Document

A Node.js key-value store built on the built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html)
module, with a promise-based key-value API.
Zero external dependencies — only Node.js built-ins (`node:sqlite`, `node:v8`,
`node:buffer`) are used.

## Goals

- A small, predictable API: `get`, `set`, `delete`, `list`, `atomic`, queues
  and watch.
- Single file, single process, embedded — no server, no network.
- No external dependencies — only `node:sqlite` and other Node.js built-ins.
- Correct, atomic, and well-tested, even if some advanced/edge features are
  more advanced features are intentionally simplified (documented below).

## Requirements

- Node.js >= 24 (`crypto.randomUUIDv7` is used for versions). Developed and tested
  against Node.js 24, where `node:sqlite` is stable.

## Public API

### `storageKV(path?, options?) => Promise<Store>`

Opens (creating if necessary) a database file at `path`. `path` defaults to
`':memory:'` for a non-persistent, in-process database. `options` lets you
tune background timers (expiration sweeps, queue polling — see
[Background tasks](#background-tasks)).

### `Store` instance methods

| Method | Description |
|---|---|
| `get(key, options?)` | Reads a single entry. Returns `{key, value, version}` or `{key, value: null, version: null}` if absent. |
| `getMany(keys, options?)` | Batched form of `get`. |
| `set(key, value, options?)` | Writes `value` at `key`. `options.expireIn` (ms) sets a relative TTL. Returns `{ok: true, version}`. |
| `delete(key)` | Removes the entry at `key`, if any. |
| `list(selector, options?)` | Returns a `StoreListIterator` (see below) over a key range. |
| `atomic()` | Returns a new `AtomicOperation` builder. |
| `enqueue(value, options?)` | Enqueues `value` for delivery to a queue listener. |
| `listenQueue(handler)` | Registers the (single) queue message handler for this instance. |
| `watch(keys)` | Returns an async iterable that yields the current state of `keys` immediately, then again on every subsequent commit. |
| `close()` | Closes the database and stops background timers. Also available as `store[Symbol.dispose]()`. |

### `AtomicOperation` (from `store.atomic()`)

Chainable builder; nothing is applied until `.commit()` is called, at which
point every check and mutation is applied in a single SQLite transaction.

| Method | Description |
|---|---|
| `check(...{key, version})` | Precondition: commit only if `key`'s current version equals `version` (`null` means "key must not exist"). |
| `set(key, value, options?)` | Queue a write. |
| `delete(key)` | Queue a delete. |
| `sum(key, n: bigint)` | Queue `StoreU64` += `n` (wrapping 64-bit addition; treats a missing key as 0). |
| `min(key, n: bigint)` / `max(key, n: bigint)` | Queue a `StoreU64` min/max-with update. |
| `enqueue(value, options?)` | Queue a message for the queue listener, as part of the same transaction. |
| `mutate(...mutations)` | Alternative object-form API for the above. |
| `commit()` | Applies everything atomically. Returns `{ok: true, version}` or `{ok: false}` if any check failed (nothing is written in that case). |

### `StoreListIterator` (from `store.list()`)

An `AsyncIterableIterator<StoreEntry>` (usable with `for await...of`) that also
exposes a `.cursor: string` property, always holding an opaque cursor
positioned just after the most recently yielded entry. Pass it back as
`options.cursor` to resume iteration later (e.g. across separate `list()`
calls, or after a process restart).

A selector is one of:

- `{ prefix }` — all keys starting with `prefix`.
- `{ prefix, start }` / `{ prefix, end }` — a sub-range within `prefix`.
- `{ start, end }` — an arbitrary range (`start` inclusive, `end` exclusive),
  with no shared prefix required.

Options: `limit`, `cursor`, `reverse`, `batchSize` (internal page size for
the lazy SQL fetch; does not affect results, only I/O granularity).

### `StoreU64`

An immutable wrapper around a `bigint` in `[0, 2^64 - 1]`, used as the value
type for `sum`/`min`/`max` atomic mutations (a 64-bit unsigned integer wrapper).

## Key encoding

A key is a non-empty array of parts, each one of `Uint8Array`, `string`,
`bigint`, `number`, or `boolean`. Keys are stored as a SQLite `BLOB PRIMARY
KEY`, encoded so that **SQLite's native byte-wise BLOB ordering exactly
matches the intended key ordering** — this is what makes prefix scans,
range scans, and reverse iteration all simple `WHERE`/`ORDER BY` SQL, with
no post-filtering or in-memory re-sorting.

Design (see [`source/key.js`](source/key.js)):

- Each part is encoded as a one-byte type tag followed by the part's
  content. Type tags order parts of different types as (ascending):
  `Uint8Array < string < bigint < number < boolean` — see
  own cross-type ordering.
- `Uint8Array` and `string` are variable-length: any `0x00` byte in the
  content is escaped as `0x00 0xFF`, and the part is closed with a
  `0x00 0x00` terminator. Since `0x00 0x00 < 0x00 0xFF`, a part that is a
  strict prefix of another always sorts first — matching plain
  byte/string comparison.
- `number` is encoded as its IEEE-754 big-endian bytes, with the standard
  order-preserving transform (flip the sign bit if non-negative; invert
  all bits if negative) so big-endian byte comparison matches numeric
  comparison, including negative numbers. `NaN` is rejected.
- `bigint` is encoded as a fixed 8-byte big-endian value, shifted into
  unsigned space. **Note:** supported range is
  `[-2^63, 2^63 - 1]` rather than arbitrary precision — a pragmatic
  trade-off for a simple, fixed-width, dependency-free encoding.
- `boolean` is one byte (`0`/`1`).
- A full key is the concatenation of its encoded parts. Because every part
  encoding is self-delimiting, concatenation is unambiguous and a key with
  fewer parts always sorts before a longer key that extends it — the
  usual prefix-ordering semantics for keys of different lengths.

Prefix scans compute an exclusive upper bound by incrementing the last
non-`0xFF` byte of the encoded prefix (dropping any trailing `0xFF` bytes);
if the prefix is all `0xFF`, there is no upper bound and the scan runs to
the end of the keyspace.

## Value encoding

Plain values are serialized with Node's built-in `node:v8` serializer
(`v8.serialize`/`v8.deserialize`), the same structured-clone-based
serializer Node uses for `worker_threads` messages. This supports objects,
arrays, `Map`, `Set`, `Date`, `RegExp`, typed arrays, etc., with zero
external dependencies. Functions and other non-cloneable values are
rejected by `v8.serialize` itself.

`StoreU64` values are special-cased and stored as a raw 8-byte little-endian
integer (prefixed with a one-byte kind tag) so that atomic `sum`/`min`/`max`
mutations can read-modify-write them without invoking the general
serializer.

## Versions

Every successful commit (a `set`, `delete`, or `atomic().commit()`) is
assigned a **version**: a UUIDv7 string (36 lowercase chars) from Node's
native `crypto.randomUUIDv7()`. Node's generator is not monotonic within a
millisecond, so [`source/version.js`](source/version.js) remembers the last
issued version and, if a fresh UUID would not sort after it, increments the
last one's low 62 random bits instead. Versions are thus strictly increasing
within a process, unique across databases, and roughly time-ordered across
processes. There is no persisted counter (the old `kv_meta` table is gone).
All keys written within one commit share that commit's version.

Databases created before this change contain old 20-char hex versions; they
still work (versions are only compared for equality) and sort before any
UUIDv7. Their unused `kv_meta` table is harmless.

**Limitation:** a `commitVersion()` sentinel
(for embedding the not-yet-known version of the current commit into a
value being written in that same commit) is not implemented.

## Atomicity & concurrency model

`node:sqlite`'s `DatabaseSync` is a **synchronous** API, and Node.js is
single-threaded. `SqliteTransactionEngine.commit()` (in [`source/engine.js`](source/engine.js)) opens
a transaction (`BEGIN IMMEDIATE`), synchronously evaluates every check,
applies every mutation, and commits — all without ever `await`-ing midway.
Since nothing can run on the event loop loop between the `BEGIN` and the
`COMMIT`/`ROLLBACK`, no other `get`/`set`/`list`/atomic call from the same
process can interleave with it, which is what makes the transaction
atomic and isolated without needing any additional application-level
locking. The public methods are still `async`/return `Promise`s purely for
a uniform asynchronous API (and to leave room for a non-blocking backend).

`BEGIN IMMEDIATE` also takes SQLite's `RESERVED` lock up front, so
concurrent **writers from other OS processes** sharing the same database
file serialize correctly instead of hitting late write-write conflicts.

## Expiration (`expireIn`)

`set(key, value, { expireIn })` stores an absolute `expires_at` (epoch ms)
alongside the entry. Expired rows are filtered out of every read
(`get`/`getMany`/`list`) immediately via a `WHERE` clause, so expiration is
always logically correct even before physical cleanup happens. Physical
deletion of expired rows happens on a background sweep timer (default every
30s, configurable via `storageKV(path, { expireCheckIntervalMs })`; pass `0` to
disable, e.g. in tests).

## Queues (`enqueue` / `listenQueue`)

A simplified, **single-process** queue, backed
by a `queue` table. `enqueue()` inserts a row; `listenQueue(handler)` starts
a poll loop (default every 50ms, configurable) that:

1. Claims the oldest due message inside a short transaction, bumping its
   `available_at` forward by a visibility timeout (default 30s) — this is
   what prevents a second poll from double-processing a message that's
   still being handled, without needing a separate "in-flight" flag.
2. Runs `handler(value)` outside the transaction (so a slow/async handler
   does not hold a database lock).
3. On success, deletes the row. On failure, retries after the next delay in
   `backoffSchedule` (default `[100, 1000, 5000, 30000]` ms); once attempts
   are exhausted, writes `value` to every key in `keysIfUndelivered` (if
   given) and drops the message.

**Limitations:** no cross-process/distributed delivery and no
exactly-once guarantees.

## Watch

`watch(keys)` returns a plain async-iterable iterator (not a
`ReadableStream`) — simpler to implement with zero dependencies, and
`ReadableStream` is itself async-iterable in modern runtimes, so typical
`for await (const x of store.watch(keys))` consumer code is unaffected by the
difference. Internally, every successful commit notifies all active
watchers, each of which re-reads just its own watched keys and pushes a new
snapshot. This is **in-process only**: changes made by other OS processes
sharing the same database file are not observed until something in *this*
process happens to poll (there is no cross-process push notification, since
SQLite has none built in).

## Consistency levels

A `{ consistency: 'strong' | 'eventual' }` read option is accepted
but has no effect: with a single local SQLite file, every
read is already strongly consistent.

## Known limitations (summary)

- `bigint` key parts are limited to `[-2^63, 2^63 - 1]`, not arbitrary
  precision.
- `commitVersion()` embedding is not implemented.
- `watch()` returns a plain async iterable, not a `ReadableStream`.
- Queues are single-process/local.
- No cross-process/cross-machine queue delivery, no queue message history, no built-in encryption/signing at rest.

## Testing notes

`npm test` runs with `--test-concurrency=1`. `node:test` runs each test file
in its own OS process by default, with several processes in flight at once;
under that default concurrency, running many short-lived `node:sqlite`
connections in parallel was observed to occasionally stall on this
project's development machine (Windows). Serializing test files avoids
that flakiness without affecting coverage — within a file, tests still run
normally.

## File layout

```
source/index.js          public entry point (require('storage-kv-sqlite'))
source/key.js            order-preserving key <-> bytes codec
source/value.js          value <-> bytes codec, StoreU64
source/version.js        version formatting
source/schema.js         SQLite schema (DDL)
source/engine.js         synchronous transactional engine (SqliteTransactionEngine)
source/list.js           list() range resolution + StoreListIterator
source/atomic.js         AtomicOperation builder
source/database.js       Store class + storageKV()
test/                    unit tests (node:test)
benchmark/benchmark.js   real-world workload benchmark
benchmark/perf.test.js   1M-record file-backed insert performance tests
```
