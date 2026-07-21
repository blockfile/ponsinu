'use strict';

// Dust-test the buy + burn legs in isolation: buy a tiny amount of the token
// with WETH on the V3 pool, then burn it (send to the dead address).
//   node scripts/burn.js <wethAmount> [--confirm]
//
// Use a tiny amount first (e.g. 0.001) and verify on the explorer that the
// tokens landed at DEAD_ADDRESS.
const { config, hr, arg, requireConfirm } = require('./_util');
const { buyToken } = require('../src/evm/swap');
const { burnToken } = require('../src/evm/burn');

(async () => {
  hr('BUY + BURN (dust test)');
  const amount = Number(arg(0));
  if (!(amount > 0)) {
    console.log('usage: node scripts/burn.js <wethAmount> [--confirm]');
    process.exit(1);
  }
  if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS is required');

  if (!(await requireConfirm(`buy ${amount} WETH of the token, then BURN it → ${config.deadAddress}`))) {
    process.exit(0);
  }

  const buy = await buyToken(config.tokenAddress, amount);
  console.log('bought:', buy.tokensBought, 'raw', buy.tokensBoughtRaw);

  const burn = await burnToken(config.tokenAddress, buy.tokensBoughtRaw);
  console.log('burned:', JSON.stringify(burn, null, 2));
  console.log(`\n✅ verify on the explorer that ${burn.burned} tokens are held by ${config.deadAddress}`);
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
