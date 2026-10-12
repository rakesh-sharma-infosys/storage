'use strict';

/**
 * @fileoverview Real-world-flavored benchmark & performance test for
 * storage-kv-sqlite. Simulates a small multi-tenant app: user profiles, a
 * time-ordered event log, per-user page-view counters, and a background
 * email queue. Run with `npm run bench` (or `node benchmark/benchmark.js`).
 *
 * This is not a micro-benchmark of individual primitives in isolation; each
 * section exercises the store the way an application actually would
 * (point lookups by id, paginated range scans, optimistic-concurrency
 * updates, a producer/consumer queue) so the numbers are representative of
 * real usage rather than best-case loop overhead.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { storageKV, StoreU64 } = require('../source/index.js');
const { reportSummarize, reportRowPrint, reportSectionPrint, reportIntFormat } = require('./lib/report.js');

const USER_COUNT = Number(process.argv[2]) || 50_000;
const EVENT_COUNT = Math.min(USER_COUNT * 4, 200_000);
const READ_SAMPLE = Math.min(USER_COUNT, 20_000);

function now() {
  return process.hrtime.bigint();
}
function elapsedMs(start) {
  return Number(now() - start) / 1e6;
}

function userRandom() {
  return 1 + Math.floor(Math.random() * USER_COUNT);
}

/**
 * Runs `fn()` `count` times sequentially, recording per-call latency.
 * @param {() => Promise<void>} fn
 * @param {number} count
 */
async function sequentialRun(fn, count) {
  const latencies = new Array(count);
  const start = now();
  for (let i = 0; i < count; i++) {
    const t0 = now();
    await fn(i);
    latencies[i] = elapsedMs(t0);
  }
  return reportSummarize(latencies, count, elapsedMs(start));
}

/**
 * Runs `fn(i)` `count` times with up to `concurrency` in flight at once,
 * recording per-call latency. Approximates real request-handling
 * concurrency (e.g. concurrent HTTP requests) better than a tight
 * sequential loop.
 * @param {(i: number) => Promise<void>} fn
 * @param {number} count
 * @param {number} concurrency
 */
async function concurrentRun(fn, count, concurrency) {
  const latencies = new Array(count);
  let next = 0;
  const start = now();
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= count) return;
      const t0 = now();
      await fn(i);
      latencies[i] = elapsedMs(t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return reportSummarize(latencies, count, elapsedMs(start));
}

async function main() {
  const dbPath = path.join(
    os.tmpdir(),
    `storage-kv-sqlite-bench-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  console.log(`storage-kv-sqlite benchmark`);
  console.log(`node ${process.version} on ${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs`);
  console.log(`db file: ${dbPath}`);
  console.log(`users=${reportIntFormat(USER_COUNT)} events=${reportIntFormat(EVENT_COUNT)}`);

  const store = await storageKV(dbPath, { expireCheckIntervalMs: 0 });

  // --- 1. Bulk insert: user profile records, keyed by id ------------------
  reportSectionPrint('Writes: insert user profiles (sequential, disk-backed)');
  {
    let i = 0;
    const stats = await sequentialRun(async () => {
      i++;
      await store.set(['users', i], {
        id: i,
        name: `User ${i}`,
        email: `user${i}@example.com`,
        createdAt: Date.now(),
        tags: ['beta', i % 7 === 0 ? 'vip' : 'standard'],
      });
    }, USER_COUNT);
    reportRowPrint('store.set (user profile)', stats);
  }

  // --- 2. Bulk insert: time-ordered event log ------------------------------
  reportSectionPrint('Writes: append time-ordered event log entries');
  {
    let i = 0;
    const baseTs = Date.now();
    const stats = await sequentialRun(async () => {
      i++;
      const ts = baseTs + i;
      await store.set(['events', ts, i], {
        userId: userRandom(),
        type: i % 5 === 0 ? 'purchase' : 'pageview',
        ts,
      });
    }, EVENT_COUNT);
    reportRowPrint('store.set (event, time-ordered key)', stats);
  }

  // --- 3. Random point reads ------------------------------------------------
  reportSectionPrint('Reads: random point lookups by id');
  {
    const stats = await sequentialRun(async () => {
      await store.get(['users', userRandom()]);
    }, READ_SAMPLE);
    reportRowPrint('store.get (random user)', stats);
  }

  // --- 4. Batched reads (getMany) -------------------------------------------
  reportSectionPrint('Reads: batched getMany (simulates a "load these 20 ids" API call)');
  {
    const batchSize = 20;
    const batches = Math.floor(READ_SAMPLE / batchSize);
    const stats = await sequentialRun(async () => {
      const keys = Array.from({ length: batchSize }, () => ['users', userRandom()]);
      await store.getMany(keys);
    }, batches);
    reportRowPrint(`store.getMany (batches of ${batchSize})`, stats, 'batch/sec');
    console.log(
      `  => effective ${reportIntFormat(stats.opsPerSec * batchSize)} individual reads/sec`
    );
  }

  // --- 5. Concurrent mixed read/write (realistic request-handling load) ---
  reportSectionPrint('Mixed workload: concurrent reads + writes (concurrency=50)');
  {
    const total = 20_000;
    const stats = await concurrentRun(
      async () => {
        const r = Math.random();
        if (r < 0.8) {
          await store.get(['users', userRandom()]);
        } else if (r < 0.95) {
          const id = userRandom();
          await store.set(['users', id], { id, name: `User ${id}`, touchedAt: Date.now() });
        } else {
          const count = [];
          for await (const entry of store.list({ prefix: ['users'] }, { limit: 10 })) {
            count.push(entry);
          }
        }
      },
      total,
      50
    );
    reportRowPrint('80% get / 15% set / 5% list(limit 10)', stats, 'req/sec');
  }

  // --- 6. Range scans (pagination, as a paginated API endpoint would do) --
  reportSectionPrint('Range scans: paginated list() over the full user range');
  {
    const pageSize = 200;
    let pages = 0;
    let rows = 0;
    const start = now();
    let cursor;
    do {
      const it = store.list({ prefix: ['users'] }, { limit: pageSize, cursor });
      let count = 0;
      for await (const entry of it) count++;
      cursor = it.cursor;
      pages++;
      rows += count;
      if (count < pageSize) break;
    } while (true);
    const totalMs = elapsedMs(start);
    console.log(
      `  ${reportIntFormat(pages)} pages, ${reportIntFormat(rows)} rows in ${totalMs.toFixed(1)}ms` +
        ` => ${reportIntFormat(rows / (totalMs / 1000))} rows/sec, ${reportIntFormat(pages / (totalMs / 1000))} pages/sec`
    );
  }

  // --- 7. Time-range scan on the event log (a common analytics query) -----
  reportSectionPrint('Range scans: recent-events time-range query');
  {
    const sample = 500;
    const stats = await sequentialRun(async () => {
      const entries = [];
      for await (const entry of store.list({ prefix: ['events'] }, { reverse: true, limit: 50 })) {
        entries.push(entry);
      }
    }, sample);
    reportRowPrint('list last 50 events (reverse, limit 50)', stats, 'query/sec');
  }

  // --- 8. Hot counter: StoreU64 sum mutation under contention -----------------
  reportSectionPrint('Atomic counters: StoreU64 sum() on a small set of hot keys');
  {
    const hotKeys = Array.from({ length: 20 }, (_, i) => ['stats', 'pageviews', i]);
    const total = 20_000;
    const stats = await concurrentRun(
      async () => {
        const key = hotKeys[Math.floor(Math.random() * hotKeys.length)];
        await store.atomic().sum(key, 1n).commit();
      },
      total,
      25
    );
    reportRowPrint('atomic().sum(key, 1n) on 20 hot keys', stats, 'incr/sec');
    const sample = await store.get(hotKeys[0]);
    console.log(`  sample counter value: ${sample.value instanceof StoreU64 ? sample.value.value : sample.value}`);
  }

  // --- 9. Optimistic concurrency: check-and-set with retries --------------
  reportSectionPrint('Optimistic concurrency: read-check-set loop under contention');
  {
    const key = ['shared-counter'];
    await store.set(key, new StoreU64(0n));
    const total = 5_000;
    let totalRetries = 0;
    const stats = await concurrentRun(
      async () => {
        while (true) {
          const entry = await store.get(key);
          const next = entry.value.value + 1n;
          const result = await store
            .atomic()
            .check({ key, version: entry.version })
            .set(key, new StoreU64(next))
            .commit();
          if (result.ok) return;
          totalRetries++;
        }
      },
      total,
      25
    );
    reportRowPrint('CAS increment (concurrency=25)', stats, 'incr/sec');
    const final = await store.get(key);
    console.log(`  final value: ${final.value.value} (expected ${total}), retries: ${reportIntFormat(totalRetries)}`);
  }

  // --- 10. Queue throughput: producer/consumer -----------------------------
  reportSectionPrint('Queue: enqueue + background listenQueue consumer throughput');
  {
    const jobCount = 5_000;
    let processed = 0;
    const store2 = await storageKV(dbPath + '.queue', { expireCheckIntervalMs: 0, queuePollIntervalMs: 1 });
    const done = new Promise((resolve) => {
      store2.listenQueue(async () => {
        processed++;
        if (processed === jobCount) resolve();
      });
    });
    const start = now();
    for (let i = 0; i < jobCount; i++) {
      await store2.enqueue({ job: 'send-welcome-email', userId: i });
    }
    await done;
    const totalMs = elapsedMs(start);
    console.log(
      `  ${reportIntFormat(jobCount)} jobs enqueued + processed in ${totalMs.toFixed(1)}ms` +
        ` => ${reportIntFormat(jobCount / (totalMs / 1000))} jobs/sec end-to-end`
    );
    store2.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + '.queue' + suffix, { force: true });
    }
  }

  store.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
