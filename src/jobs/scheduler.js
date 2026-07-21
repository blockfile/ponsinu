'use strict';

const cron = require('node-cron');
const config = require('../config');
const { runCycle } = require('./cycle');
const { getClaimableEth, simulateFeeAccrual } = require('../evm/pons');
const { getEthPriceUsd } = require('../evm/price');
const bus = require('../events');

const state = {
  task: null,
  paused: false,
  isRunning: false,
  lastRunAt: null,
  lastResult: null, // { id, status }
  lastClaimable: null,
  lastClaimableUsd: null,
  startedAt: null,
};

/**
 * One timer tick (every POLL_SCHEDULE, default 5 minutes). Advances the simulated
 * fee accrual (DRY_RUN only), reads the loop's WETH fuel (wallet balance + the
 * creator share pending in the locker), and runs a claim → buyback → burn cycle
 * once there is enough to spend BURN_USD_PER_CYCLE. Skips silently (no cycle
 * row) otherwise. Overlap-guarded.
 * @param {string} trigger 'poll' | 'manual'
 * @returns {Promise<{ran:boolean, claimable?:number, claimableUsd?:number, reason?:string, cycle?:object}>}
 */
async function pollOnce(trigger) {
  if (state.paused) return { ran: false, reason: 'paused' };
  if (state.isRunning) {
    console.log(`[scheduler] ${trigger} tick ignored — a cycle is already running`);
    return { ran: false, reason: 'cycle already running' };
  }

  // Hold the run flag through the balance/price reads too — a manual
  // POST /api/run landing between these awaits and the cycle start must not
  // spawn a second concurrent cycle (wallet-nonce contention in live mode).
  state.isRunning = true;
  try {
    simulateFeeAccrual(); // no-op in live mode
    const spendable = await getClaimableEth(); // wallet WETH + pending locker fees
    state.lastClaimable = spendable;

    // Size the fixed-USD buy against the live ETH price. Hold if we can't price it.
    const price = await getEthPriceUsd();
    if (price == null) {
      return { ran: false, claimable: spendable, reason: 'ETH price unavailable — cannot size the buy' };
    }
    const buyEth = config.burnUsdPerCycle / price;
    const spendableUsd = +(spendable * price).toFixed(2);
    state.lastClaimableUsd = spendableUsd;

    // Need at least one buy's worth of fees (claimed + pending); otherwise wait.
    if (spendable < buyEth) {
      return {
        ran: false,
        claimable: spendable,
        claimableUsd: spendableUsd,
        reason: `insufficient fees ($${spendableUsd} < $${config.burnUsdPerCycle})`,
      };
    }

    state.lastRunAt = new Date().toISOString();
    const cycle = await runCycle(+buyEth.toFixed(9));
    state.lastResult = { id: cycle.id, status: cycle.status };
    return { ran: true, claimable: spendable, claimableUsd: spendableUsd, cycle };
  } finally {
    state.isRunning = false;
  }
}

function start() {
  if (state.task) return;
  if (!cron.validate(config.pollSchedule)) {
    throw new Error(`Invalid POLL_SCHEDULE: ${config.pollSchedule}`);
  }
  state.startedAt = new Date().toISOString();
  state.task = cron.schedule(config.pollSchedule, () => {
    pollOnce('poll').catch((err) => console.error('[scheduler] poll error:', err));
  });
  console.log(
    `[scheduler] started — claims fees, buys back $${config.burnUsdPerCycle} + burns on schedule "${config.pollSchedule}" (dryRun=${config.dryRun})`
  );
}

function pause() {
  state.paused = true;
  const s = getState();
  bus.emit('scheduler', s);
  return s;
}

function resume() {
  state.paused = false;
  const s = getState();
  bus.emit('scheduler', s);
  return s;
}

/** Manual trigger from the API — forces a cycle immediately, off-schedule. */
async function triggerNow() {
  if (state.isRunning) return { skipped: true, reason: 'cycle already running' };
  state.isRunning = true;
  state.lastRunAt = new Date().toISOString();
  try {
    const cycle = await runCycle();
    state.lastResult = { id: cycle.id, status: cycle.status };
    return cycle;
  } finally {
    state.isRunning = false;
  }
}

function getState() {
  return {
    pollSchedule: config.pollSchedule,
    burnUsdPerCycle: config.burnUsdPerCycle,
    paused: state.paused,
    isRunning: state.isRunning,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
    lastClaimable: state.lastClaimable,
    lastClaimableUsd: state.lastClaimableUsd,
    startedAt: state.startedAt,
  };
}

module.exports = { start, pause, resume, triggerNow, pollOnce, getState };
