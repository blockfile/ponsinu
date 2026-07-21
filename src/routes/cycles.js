'use strict';

const express = require('express');
const repo = require('../db/repository');
const { getEthPriceUsd } = require('../evm/price');
const { toActivityRow } = require('../services/format');

const router = express.Router();

function clamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// GET /api/cycles?limit=&offset=  — paginated history
router.get('/cycles', async (req, res, next) => {
  try {
    const limit = clamp(req.query.limit, 25, 1, 200);
    const offset = clamp(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const { total, items } = await repo.getCycles(limit, offset);
    res.json({ total, limit, offset, items });
  } catch (err) {
    next(err);
  }
});

// GET /api/cycles/:id — one cycle with its steps
router.get('/cycles/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
    const cycle = await repo.getCycleWithSteps(id);
    if (!cycle) return res.status(404).json({ error: 'cycle not found' });
    res.json(cycle);
  } catch (err) {
    next(err);
  }
});

// GET /api/transactions?limit=&offset=  — enriched activity feed for the dashboard table
router.get('/transactions', async (req, res, next) => {
  try {
    const limit = clamp(req.query.limit, 50, 1, 500);
    const offset = clamp(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const [steps, price] = await Promise.all([repo.getAllSteps(limit, offset), getEthPriceUsd()]);
    res.json({
      limit,
      offset,
      ethPriceUsd: price,
      items: steps.map((s) => toActivityRow(s, price)),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
