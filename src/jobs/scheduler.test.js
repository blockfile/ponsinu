'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('pollOnce: skips with no fees, waits below one buy, runs when there is enough', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  process.env.DRY_RUN_FEE_PER_POLL = '0'; // no auto-accrual — we control the fee state
  process.env.DRY_RUN_TOKEN_FEE_PER_POLL = '0';
  process.env.BURN_USD_PER_CYCLE = '5';
  process.env.BUY_PCT = '100';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsinu_test_sched';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../evm/simvault');
  const price = require('../evm/price');
  const scheduler = require('./scheduler');
  await db.connect();
  try {
    price._prime(3000); // deterministic ETH price — no network fetch

    // No fees anywhere → tick skips silently, no cycle row written.
    simvault.reset();
    const p1 = await scheduler.pollOnce('poll');
    assert.strictEqual(p1.ran, false);
    assert.match(p1.reason, /insufficient fees/);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0, 'no cycle with no fees');

    // Below one buy ($1.50 < $5) → wait, no cycle.
    simvault.reset({ pendingWeth: 0.0005 }); // 0.0005 WETH * $3000 = $1.50
    const p2 = await scheduler.pollOnce('poll');
    assert.strictEqual(p2.ran, false);
    assert.strictEqual(p2.claimableUsd, 1.5);
    assert.match(p2.reason, /insufficient fees/);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 0, 'no cycle below one buy');

    // Enough fees pending ($150 >= $5) → the tick claims, buys back + burns.
    simvault.reset({ pendingWeth: 0.05, pendingTokens: 500 });
    const p3 = await scheduler.pollOnce('poll');
    assert.strictEqual(p3.ran, true);
    assert.strictEqual(p3.cycle.status, 'complete');
    assert.deepStrictEqual(p3.cycle.steps.map((s) => s.name), ['claim', 'buy', 'burn']);
    assert.strictEqual((await repo.getCycles(10, 0)).total, 1, 'one cycle once there is enough');

    // Wallet WETH left over from the claim also counts as fuel next tick.
    assert.ok(simvault.peek().walletWeth > 0, 'unspent claimed WETH remains for future buys');
  } finally {
    await db.close();
    await mongod.stop();
    delete process.env.DRY_RUN_FEE_PER_POLL;
    delete process.env.DRY_RUN_TOKEN_FEE_PER_POLL;
    delete process.env.BURN_USD_PER_CYCLE;
    delete process.env.BUY_PCT;
    delete require.cache[require.resolve('../config')];
  }
});
