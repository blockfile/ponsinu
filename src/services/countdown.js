'use strict';

// Interval minutes from a "*/N * * * *" cron schedule's minute field; default 5
// for non-interval schedules (we only support fixed N-minute schedules here).
function intervalMinutes(schedule) {
  const minuteField = String(schedule || '').trim().split(/\s+/)[0] || '*/5';
  const m = /^\*\/(\d+)$/.exec(minuteField);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0) return n;
  }
  return 5;
}

// Next cron fire time (epoch ms) strictly after nowMs for a "*/N * * * *" schedule:
// the next local-time minute boundary where minute % N === 0 and seconds are 0.
function nextRun(schedule, nowMs) {
  const intervalMin = intervalMinutes(schedule);
  const d = new Date(nowMs);
  d.setSeconds(0, 0);
  do {
    d.setMinutes(d.getMinutes() + 1);
  } while (d.getMinutes() % intervalMin !== 0);
  return { nextAirdropAt: d.getTime(), intervalSec: intervalMin * 60 };
}

module.exports = { nextRun, intervalMinutes };
