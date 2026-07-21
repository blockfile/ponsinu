'use strict';

// Test the claim leg in isolation: collect the creator share of the locked-LP
// trading fees from the PonsLaunchLocker (arrives as WETH + the token).
//   node scripts/claim.js [--confirm]
//
// Without --confirm this only PREVIEWS what is claimable (a static call — no
// transaction). The wallet must be the token's deployer.
const { config, hr, requireConfirm } = require('./_util');
const { getPendingCreatorFees, collectCreatorFees, getLaunchInfo } = require('../src/evm/pons');

(async () => {
  hr('CLAIM CREATOR FEES');
  if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS is required');

  const pending = await getPendingCreatorFees();
  if (pending.authorized) {
    console.log(`claimable: ${pending.weth} WETH + ${pending.tokens} ${config.tokenSymbol}`);
  } else {
    console.log('⚠️ claim probe reverted:', pending.error);
    console.log('   (either no fees have accrued yet, or this wallet is not the token\'s deployer)');
  }

  const locker = config.dryRun ? '(simulated)' : (await getLaunchInfo()).locker;
  if (!(await requireConfirm(`claim the creator fees from the locker ${locker}`))) {
    process.exit(0);
  }
  const result = await collectCreatorFees();
  console.log('\nresult:', JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
