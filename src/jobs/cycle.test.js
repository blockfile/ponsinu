'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('runCycle (DRY_RUN): claim → buy back 0.01 WETH → burn (bought + claimed fees)', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  process.env.BURN_USD_PER_CYCLE = '5';
  process.env.BUY_PCT = '100';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsinu_test_cycle';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../evm/simvault');
  const price = require('../evm/price');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    price._prime(3000); // display-only in ETH mode — the trigger needs no price
    // 0.05 WETH + 1000 tokens of creator fees pending in the locker.
    simvault.reset({ pendingWeth: 0.05, pendingTokens: 1000 });
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete');
    assert.strictEqual(cycle.mode, 'claim-buyback-burn');

    // Full loop: claim from the locker, then buy, then burn.
    assert.deepStrictEqual(cycle.steps.map((s) => s.name), ['claim', 'buy', 'burn']);

    // Claims the whole pending WETH side, spends BURN_ETH_PER_CYCLE on the buy.
    assert.strictEqual(cycle.eth_claimed, 0.05);
    assert.strictEqual(cycle.eth_spent_buy, 0.01, 'spends the fixed 0.01 WETH per cycle');
    assert.ok(cycle.tokens_bought > 0);

    // Burns what it bought PLUS the claimed token-side fees.
    assert.ok(Math.abs(cycle.tokens_burned - (cycle.tokens_bought + 1000)) < 1e-6, 'burns bought + claimed fees');
    assert.ok(cycle.burn_sig, 'records the burn tx');

    const burn = cycle.steps.find((s) => s.name === 'burn');
    assert.strictEqual(burn.detail.deadAddress, '0x000000000000000000000000000000000000dead');
    assert.strictEqual(burn.detail.fromClaimedFees, 1000);

    // The claim emptied the simulated locker; the buy spent from the wallet.
    const s = simvault.peek();
    assert.strictEqual(s.pendingWeth, 0);
    assert.strictEqual(s.walletTokens, 0, 'claimed tokens were burned');

    const stats = await repo.getStats();
    assert.strictEqual(stats.burns, 1);
    assert.strictEqual(stats.total_eth_claimed, 0.05);
    assert.ok(stats.total_tokens_burned > 0);
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
    delete process.env.BURN_USD_PER_CYCLE;
    delete process.env.BUY_PCT;
  }
});

test('runCycle (DRY_RUN): dust pending + wallet covers the buy → no claim step', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  process.env.BURN_USD_PER_CYCLE = '5';
  process.env.BUY_PCT = '100';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsinu_test_noclaim';
  const db = require('../db/index');
  const simvault = require('../evm/simvault');
  const price = require('../evm/price');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    price._prime(3000);
    // Wallet already holds enough WETH; only dust (< CLAIM_MIN_WETH=0.0005)
    // is pending in the locker → the claim leg is skipped to save gas.
    simvault.reset({ walletWeth: 0.05, pendingWeth: 0.0001, pendingTokens: 50 });
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete');
    assert.deepStrictEqual(cycle.steps.map((s) => s.name), ['buy', 'burn']);
    assert.strictEqual(cycle.eth_claimed, 0);
    assert.strictEqual(simvault.peek().pendingWeth, 0.0001, 'dust stays in the locker for later');
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
    delete process.env.BURN_USD_PER_CYCLE;
    delete process.env.BUY_PCT;
  }
});

test('runCycle (DRY_RUN): not enough fees → skipped', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  process.env.BURN_USD_PER_CYCLE = '5';
  process.env.BUY_PCT = '100';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsinu_test_skip';
  const db = require('../db/index');
  const simvault = require('../evm/simvault');
  const price = require('../evm/price');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    price._prime(3000);
    simvault.reset({ pendingWeth: 0.0005 }); // below the 0.01 WETH per-cycle buy
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'skipped');
    assert.ok(!cycle.steps.some((s) => s.name === 'claim'));
    assert.ok(!cycle.steps.some((s) => s.name === 'buy'));
    assert.ok(!cycle.steps.some((s) => s.name === 'burn'));
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
    delete process.env.BURN_USD_PER_CYCLE;
    delete process.env.BUY_PCT;
  }
});

test('runCycle (DRY_RUN): BUY_PCT=80 → buys 0.008, keeps 0.002 as the dev cut', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  process.env.BUY_PCT = '80';
  // The earlier tests loaded cycle.js against a BUY_PCT=100 config instance —
  // drop the whole src module cache so everything rebinds to the 80/20 config.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${require('node:path').sep}src${require('node:path').sep}`) && !key.includes('node_modules')) {
      delete require.cache[key];
    }
  }
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsinu_test_split';
  const db = require('../db/index');
  const simvault = require('../evm/simvault');
  const price = require('../evm/price');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    price._prime(3000);
    simvault.reset({ pendingWeth: 0.05, pendingTokens: 100 });
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete');

    // 0.01 cycle split 80/20: buy 0.008, dev cut 0.002.
    assert.strictEqual(cycle.eth_spent_buy, 0.008, 'buys with 80% of the cycle');
    assert.strictEqual(cycle.eth_dev, 0.002, 'keeps 20% as the dev cut');

    // Both halves left the simulated WETH pool: 0.05 claimed − 0.01 cycle.
    assert.ok(Math.abs(simvault.peek().walletWeth - 0.04) < 1e-9, 'dev cut cannot be re-spent next tick');
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
    delete process.env.BUY_PCT;
  }
});
