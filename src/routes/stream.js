'use strict';

const express = require('express');
const bus = require('../events');
const { getCachedEthPriceUsd } = require('../evm/price');
const { toActivityRow, buildUnclaimedPayload } = require('../services/format');

const router = express.Router();

// GET /api/stream — Server-Sent Events. The frontend opens this once with
// EventSource and receives push updates the instant they happen:
//   event: step       → a new activity row (claim/buy/airdrop)
//   event: cycle      → { id, status, mode } when a cycle finishes
//   event: unclaimed  → the unclaimed-fees card payload
//   event: scheduler  → scheduler state on pause/resume
// Public (read-only), like the other GET endpoints. EventSource auto-reconnects.
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
  });

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('hello', { ok: true, at: new Date().toISOString() });

  // Use the cached price synchronously so events stream in emit order (no await race).
  const onStep = (step) => send('step', toActivityRow(step, getCachedEthPriceUsd()));
  const onCycle = (c) => send('cycle', c);
  const onUnclaimed = (eth) =>
    send('unclaimed', {
      ...buildUnclaimedPayload(eth, getCachedEthPriceUsd()),
      updatedAt: new Date().toISOString(),
    });
  const onScheduler = (s) => send('scheduler', s);

  bus.on('step', onStep);
  bus.on('cycle', onCycle);
  bus.on('unclaimed', onUnclaimed);
  bus.on('scheduler', onScheduler);

  // keepalive comment so proxies/browsers hold the connection open
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepalive);
    bus.off('step', onStep);
    bus.off('cycle', onCycle);
    bus.off('unclaimed', onUnclaimed);
    bus.off('scheduler', onScheduler);
  });
});

module.exports = router;
