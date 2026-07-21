'use strict';

// Public, frontend-shaped endpoints for the frontend site. These emit flat,
// ready-to-render shapes (GET /activity, /stats, /summary, /accrual, /countdown)
// so the frontend only has to point at these URLs — no field remapping.

const express = require('express');
const repo = require('../db/repository');
const { getUnclaimedEth } = require('../services/metrics');
const { getMarketData } = require('../services/marketdata');
const { getEthPriceUsd } = require('../evm/price');
const { walletAddress } = require('../evm/provider');
const { toPublicActivityRow, toPublicStats, toPublicSummary, buildUnclaimedPayload } = require('../services/format');
const config = require('../config');
const { nextRun } = require('../services/countdown');

const router = express.Router();

// Tiny in-memory TTL cache. The frontend polls activity ~4s and stats ~20s and
// the spec asks the backend to cache; this also de-dupes concurrent requests.
function cached(ttlMs, fn) {
  let value;
  let expires = 0;
  let inflight = null;
  return async () => {
    if (Date.now() < expires) return value;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        value = await fn();
        expires = Date.now() + ttlMs;
        return value;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

const loadActivity = cached(3000, async () => {
  const [steps, price] = await Promise.all([repo.getAllSteps(100, 0), getEthPriceUsd()]);
  return steps.map((s) => toPublicActivityRow(s, price)); // repo returns newest-first
});

const loadStats = cached(15000, async () => {
  const [stats, unclaimed, market] = await Promise.all([
    repo.getStats(),
    getUnclaimedEth().catch(() => ({ eth: null })),
    getMarketData().catch(() => ({ tokenInLp: null, marketCap: null })),
  ]);
  return toPublicStats({
    stats,
    unclaimedEth: unclaimed.eth,
    operatingWallet: walletAddress(),
    market,
  });
});

// GET /activity — array of transactions, newest first
router.get('/activity', async (req, res, next) => {
  try {
    res.json(await loadActivity());
  } catch (err) {
    next(err);
  }
});

// GET /stats — single object of live numbers
router.get('/stats', async (req, res, next) => {
  try {
    res.json(await loadStats());
  } catch (err) {
    next(err);
  }
});

// GET /countdown — authoritative next-cycle time for a synced frontend countdown
// (cycles run on a fixed timer, default every minute). Not cached: serverTime
// must be fresh so the client can anchor to the server clock.
router.get('/countdown', (req, res) => {
  const now = Date.now();
  const { nextAirdropAt, intervalSec } = nextRun(config.pollSchedule, now);
  res.json({ serverTime: now, nextCycleAt: nextAirdropAt, intervalSec });
});

// Headline numbers for the frontend hero.
const loadSummary = cached(10000, async () => {
  const [stats, price, market] = await Promise.all([
    repo.getStats(),
    getEthPriceUsd().catch(() => 0),
    getMarketData().catch(() => ({ marketCap: null })),
  ]);
  return toPublicSummary({ stats, price, marketCapUsd: market.marketCap ?? null });
});

// GET /summary — hero headline stats.
router.get('/summary', async (req, res, next) => {
  try {
    res.json(await loadSummary());
  } catch (err) {
    next(err);
  }
});

// GET /accrual — fees accrued toward the next claim, frontend-shaped
// ({ accruedUsd, thresholdUsd }). Public mirror of /api/unclaimed.
const loadAccrual = cached(15000, async () => {
  const [{ eth }, price] = await Promise.all([getUnclaimedEth(), getEthPriceUsd()]);
  const { unclaimedUsd, claimThresholdUsd } = buildUnclaimedPayload(eth, price);
  return { accruedUsd: unclaimedUsd ?? 0, thresholdUsd: claimThresholdUsd };
});
router.get('/accrual', async (req, res, next) => {
  try {
    res.json(await loadAccrual());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
