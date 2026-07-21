'use strict';

// Buy the token with a given amount of WETH on the Uniswap V3 launch pool
// (via SwapRouter02). The wallet must hold the WETH — claim fees first.
//   node scripts/buy.js <wethAmount> [--confirm]
const { config, hr, arg, requireConfirm } = require('./_util');
const { buyToken } = require('../src/evm/swap');

(async () => {
  hr('BUY TOKEN');
  const amount = Number(arg(0));
  if (!(amount > 0)) {
    console.log('usage: node scripts/buy.js <wethAmount> [--confirm]');
    process.exit(1);
  }
  if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS is required');

  if (!(await requireConfirm(`buy ${config.tokenAddress} with ${amount} WETH on the V3 pool`))) {
    process.exit(0);
  }
  const result = await buyToken(config.tokenAddress, amount);
  console.log('\nresult:', JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
