'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('config exposes the claim-buyback-burn defaults', () => {
  const config = require('./config');
  assert.strictEqual(config.burnEthPerCycle, 0.01);
  assert.strictEqual(config.burnUsdPerCycle, 5);
  assert.strictEqual(config.slippagePct, 5);
  assert.strictEqual(config.pollSchedule, '*/5 * * * *');
  assert.strictEqual(config.dryRunFeePerPoll, 0.01);
  assert.strictEqual(config.chainId, 4663);
  assert.strictEqual(config.deadAddress, '0x000000000000000000000000000000000000dead');
  // Pons launchpad infra on Robinhood Chain (ponsfamily.com deployment).
  // The locker is auto-discovered from the token's launchFactory() at runtime;
  // config only carries an explicit LOCKER_ADDRESS override.
  assert.strictEqual(config.locker, null);
  assert.strictEqual(config.swapRouter, '0xcaf681a66d020601342297493863e78c959e5cb2');
  assert.strictEqual(config.weth, '0x0bd7d308f8e1639fab988df18a8011f41eacad73');
  // Claim tuning: dust claims are skipped; claimed token fees are burned.
  assert.strictEqual(config.claimMinWeth, 0.0005);
  assert.strictEqual(config.burnClaimedTokens, true);
});

test('BURN_USD_PER_CYCLE and DEAD_ADDRESS are overridable', () => {
  delete require.cache[require.resolve('./config')];
  process.env.BURN_USD_PER_CYCLE = '10';
  process.env.DEAD_ADDRESS = '0x000000000000000000000000000000000000DEAD';
  const config = require('./config');
  assert.strictEqual(config.burnUsdPerCycle, 10);
  assert.strictEqual(config.deadAddress, '0x000000000000000000000000000000000000dead');
  delete process.env.BURN_USD_PER_CYCLE;
  delete process.env.DEAD_ADDRESS;
  delete require.cache[require.resolve('./config')];
});
