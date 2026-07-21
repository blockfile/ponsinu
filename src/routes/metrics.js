'use strict';

const express = require('express');
const { getUnclaimedEth } = require('../services/metrics');
const { getEthPriceUsd } = require('../evm/price');
const { buildUnclaimedPayload } = require('../services/format');

const router = express.Router();

// GET /api/unclaimed — live unclaimed creator fees (cached ~20s), with USD.
// Poll this for the "UNCLAIMED FEES" card, or get it pushed via GET /api/stream.
router.get('/unclaimed', async (req, res, next) => {
  try {
    const [{ eth, at }, price] = await Promise.all([getUnclaimedEth(), getEthPriceUsd()]);
    res.json({
      ...buildUnclaimedPayload(eth, price),
      updatedAt: new Date(at).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
