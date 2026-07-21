'use strict';

const express = require('express');
const scheduler = require('../jobs/scheduler');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

// All control endpoints require the API key (when API_KEY is configured).
router.use(requireApiKey);

// POST /api/run — trigger a cycle now (overlap-guarded)
router.post('/run', async (req, res) => {
  try {
    const result = await scheduler.triggerNow();
    if (result && result.skipped) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pause — stop running on the schedule
router.post('/pause', (req, res) => {
  res.json(scheduler.pause());
});

// POST /api/resume — resume the schedule
router.post('/resume', (req, res) => {
  res.json(scheduler.resume());
});

module.exports = router;
