'use strict';

/**
 * @fileoverview Tiny, dependency-free benchmark reporting helpers: latency
 * reportPercentile math and a plain-text results table.
 */

/**
 * @param {number[]} sortedLatenciesMs Already sorted ascending.
 * @param {number} p 0..1
 * @returns {number}
 */
function reportPercentile(sortedLatenciesMs, p) {
  if (sortedLatenciesMs.length === 0) return 0;
  const idx = Math.min(
    sortedLatenciesMs.length - 1,
    Math.floor(p * sortedLatenciesMs.length)
  );
  return sortedLatenciesMs[idx];
}

/**
 * Summarizes a list of per-operation latencies (in milliseconds) collected
 * during a benchmark run.
 * @param {number[]} latenciesMs
 * @param {number} totalOps
 * @param {number} totalMs wall-clock time for the whole run
 * @returns {{opsPerSec: number, p50: number, p95: number, p99: number, max: number, totalMs: number}}
 */
function reportSummarize(latenciesMs, totalOps, totalMs) {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return {
    opsPerSec: totalOps / (totalMs / 1000),
    p50: reportPercentile(sorted, 0.5),
    p95: reportPercentile(sorted, 0.95),
    p99: reportPercentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    totalMs,
  };
}

/** @param {number} n */
function reportIntFormat(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** @param {number} n */
function reportMsFormat(n) {
  return `${n.toFixed(3)}ms`;
}

/**
 * Prints a row of a fixed-width results table.
 * @param {string} name
 * @param {{opsPerSec:number,p50:number,p95:number,p99:number,max:number,totalMs:number}} stats
 * @param {string} [unit]
 */
function reportRowPrint(name, stats, unit = 'ops/sec') {
  console.log(
    `${name.padEnd(42)} ${reportIntFormat(stats.opsPerSec).padStart(12)} ${unit.padEnd(9)}` +
      ` p50=${reportMsFormat(stats.p50).padStart(9)} p95=${reportMsFormat(stats.p95).padStart(9)}` +
      ` p99=${reportMsFormat(stats.p99).padStart(9)} max=${reportMsFormat(stats.max).padStart(9)}` +
      ` total=${reportMsFormat(stats.totalMs)}`
  );
}

/** @param {string} title */
function reportSectionPrint(title) {
  console.log('');
  console.log(`== ${title} ==`);
}

module.exports = { reportSummarize, reportPercentile, reportRowPrint, reportSectionPrint, reportIntFormat, reportMsFormat };
