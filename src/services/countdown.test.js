'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nextRun, intervalMinutes } = require('./countdown');

// Local-time helper: epoch ms for 2026-06-29 hh:mm:ss.
const at = (h, m, s) => new Date(2026, 5, 29, h, m, s).getTime();

test('nextRun targets the next 5-minute boundary', () => {
  const r = nextRun('*/5 * * * *', at(12, 1, 30));
  assert.strictEqual(r.nextAirdropAt, at(12, 5, 0));
  assert.strictEqual(r.intervalSec, 300);
});

test('nextRun on a boundary rolls to the NEXT slot', () => {
  const r = nextRun('*/5 * * * *', at(12, 5, 0));
  assert.strictEqual(r.nextAirdropAt, at(12, 10, 0));
});

test('intervalMinutes parses */N and falls back to 5 otherwise', () => {
  assert.strictEqual(intervalMinutes('*/5 * * * *'), 5);
  assert.strictEqual(intervalMinutes('*/3 * * * *'), 3);
  assert.strictEqual(intervalMinutes('* * * * *'), 5);
});
