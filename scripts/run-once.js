'use strict';

// Run ONE full cycle (claim creator fees → buy back BURN_ETH_PER_CYCLE WETH of
// the token → burn the wallet's whole token balance) and record it. The
// integration test.
//   node scripts/run-once.js [--confirm]
const { requireConfirm, hr } = require('./_util');
const db = require('../src/db');
const { runCycle } = require('../src/jobs/cycle');

(async () => {
  hr('RUN ONE FULL CYCLE');
  if (!(await requireConfirm('run one full cycle (claim → buy back → burn)'))) {
    process.exit(0);
  }
  await db.connect();
  const cycle = await runCycle();
  console.log('\ncycle result:');
  console.log(JSON.stringify(cycle, null, 2));
  await db.close();
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
