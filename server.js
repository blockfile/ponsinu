'use strict';

const express = require('express');
const cors = require('cors');

const config = require('./src/config');
const db = require('./src/db');
const { walletAddress } = require('./src/evm/provider');
const scheduler = require('./src/jobs/scheduler');
const { getEthPriceUsd } = require('./src/evm/price');

const statusRoutes = require('./src/routes/status');
const cycleRoutes = require('./src/routes/cycles');
const controlRoutes = require('./src/routes/control');
const metricsRoutes = require('./src/routes/metrics');
const streamRoutes = require('./src/routes/stream');
const publicRoutes = require('./src/routes/public');

const app = express();

// CORS allowlist — non-browser requests (no Origin) always pass; browsers are
// restricted to config.corsOrigins (or any origin if it contains "*").
const allowAll = config.corsOrigins.includes('*');
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowAll || config.corsOrigins.includes(origin)) return cb(null, true);
      const err = new Error(`origin ${origin} not allowed by CORS`);
      err.corsRejected = true; // handled quietly below — copycat sites spam this
      return cb(err);
    },
  })
);
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    name: 'ponsinu',
    description:
      'ponsfamily.com creator fees (locked-LP WETH + token) → claim from the locker → buy your token back on Uniswap V3 → burn it (Robinhood Chain)',
    dryRun: config.dryRun,
    chainId: config.chainId,
    wallet: walletAddress(),
    endpoints: [
      'GET  /activity',
      'GET  /stats',
      'GET  /summary',
      'GET  /accrual',
      'GET  /countdown',
      'GET  /api/status',
      'GET  /api/unclaimed',
      'GET  /api/stream (SSE live push)',
      'GET  /api/cycles',
      'GET  /api/cycles/:id',
      'GET  /api/transactions',
      'POST /api/run',
      'POST /api/pause',
      'POST /api/resume',
    ],
  });
});

app.use('/api', statusRoutes);
app.use('/api', cycleRoutes);
app.use('/api', controlRoutes);
app.use('/api', metricsRoutes);
app.use('/api', streamRoutes);

// Public, frontend-shaped endpoints (GET /activity, GET /stats) for the site.
app.use('/', publicRoutes);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Disallowed origins (copycat sites embedding this API) get a terse 403 and at
// most ONE log line per origin — not a stack trace per request.
const loggedBlockedOrigins = new Set();

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.corsRejected) {
    const origin = req.get('origin') || 'unknown';
    if (!loggedBlockedOrigins.has(origin)) {
      loggedBlockedOrigins.add(origin);
      console.warn(`[ponsinu] blocking CORS origin: ${origin}`);
    }
    return res.status(403).json({ error: 'origin not allowed' });
  }
  console.error('[ponsinu] request error:', err);
  res.status(500).json({ error: err.message });
});

let server;

async function main() {
  await db.connect();
  console.log(`[ponsinu] MongoDB connected (${config.mongoDb})`);

  getEthPriceUsd().catch(() => {}); // warm the price cache for USD values

  server = app.listen(config.port, () => {
    console.log(`[ponsinu] listening on http://localhost:${config.port}`);
    console.log(`[ponsinu] dryRun=${config.dryRun} chainId=${config.chainId} wallet=${walletAddress()}`);
    if (config.walletIsEphemeral) {
      console.log('[ponsinu] WARNING: using an ephemeral wallet (no WALLET_PRIVATE_KEY set) — dry run only');
    }
    scheduler.start();
  });
}

async function shutdown(signal) {
  console.log(`\n[ponsinu] ${signal} received, shutting down`);
  if (server) server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[ponsinu] failed to start:', err);
  process.exit(1);
});

module.exports = app;
