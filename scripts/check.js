'use strict';

// Read-only preflight. Sends NO transactions. Verifies your config + on-chain state:
// RPC/chain, wallet balances, the token's launch wiring (V3 pool, fee tier, WETH
// pair), the locker's pending creator fees (and whether THIS wallet may claim
// them), and a spot-price quote for the buy leg.
//   node scripts/check.js
const { formatEther, formatUnits } = require('ethers');
const { config, provider, wallet, hr } = require('./_util');

(async () => {
  hr('CONFIG');
  console.log('dryRun     :', config.dryRun);
  console.log('rpcUrl     :', config.rpcUrl, `(chain ${config.chainId})`);
  console.log('wallet     :', wallet.address, config.walletIsEphemeral ? '⚠️ EPHEMERAL — set WALLET_PRIVATE_KEY' : '');
  console.log('token      :', config.tokenAddress || '⚠️ MISSING — set TOKEN_ADDRESS');
  const perCycle = config.burnEthPerCycle > 0 ? `${config.burnEthPerCycle} WETH` : `$${config.burnUsdPerCycle}`;
  console.log('buy/burn   :', `${perCycle} bought back + burned per cycle (${config.pollSchedule})`);
  console.log('deadAddr   :', config.deadAddress, '(burn sink)');
  console.log('locker     :', config.locker || 'auto — discovered from the token\'s launchFactory()', '(PonsLaunchLocker — collectFees claims the creator fees)');
  console.log('router     :', config.swapRouter, '(Uniswap V3 SwapRouter02 — WETH → token buy path)');
  console.log('weth       :', config.weth);

  hr('RPC + WALLET BALANCES');
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== config.chainId) {
    console.log(`⚠️ RPC reports chain ${net.chainId}, expected ${config.chainId}`);
  } else {
    console.log('chainId    :', Number(net.chainId), '✓');
  }
  const wei = await provider.getBalance(wallet.address);
  console.log('ETH balance:', formatEther(wei), 'ETH (gas)');
  if (wei === 0n) console.log('⚠️ wallet has 0 ETH — fund it before any live test');

  if (!config.tokenAddress) {
    console.log('\nSet TOKEN_ADDRESS to run the remaining checks.');
    process.exit(0);
  }

  if (config.dryRun) {
    console.log('\n(DRY_RUN — on-chain reads are simulated; set DRY_RUN=false to check the real launch wiring)');
    console.log('\n✅ preflight complete (no transactions sent)');
    process.exit(0);
  }

  hr('PONS LAUNCH WIRING (read from the token)');
  const { getLaunchInfo, getPendingCreatorFees, lockerContract } = require('../src/evm/pons');
  const { getWethBalanceEth, getDecimals } = require('../src/evm/erc20');
  const info = await getLaunchInfo();
  console.log('V3 pool    :', info.pool, `(fee tier ${info.poolFee / 10000}%)`);
  console.log('locker     :', info.locker, config.locker ? '(LOCKER_ADDRESS override)' : '(auto-discovered from the launch factory ✓)');
  console.log('pairToken  :', info.pairToken, info.pairToken === config.weth ? '(WETH ✓)' : '⚠️ NOT the configured WETH — buy path assumes WETH');
  console.log('deployer   :', info.deployer, info.deployer === wallet.address.toLowerCase() ? '(this wallet ✓)' : '⚠️ NOT this wallet — only the deployer can claim the creator fees');
  if (info.restrictionEndBlock != null) {
    const block = await provider.getBlockNumber();
    if (block <= info.restrictionEndBlock) {
      console.log(`⚠️ launch restrictions active until block ${info.restrictionEndBlock} (now ${block}) — max-wallet/max-tx limits apply to pool buys`);
    } else {
      console.log('restrictions: ended ✓ (plain ERC-20 behavior)');
    }
  }
  try {
    const redirect = await lockerContract().feeRedirects(config.tokenAddress);
    const zero = '0x0000000000000000000000000000000000000000';
    if (redirect !== zero && redirect.toLowerCase() !== wallet.address.toLowerCase()) {
      console.log(`⚠️ feeRedirect is set to ${redirect} — claimed fees will land THERE, not in this wallet`);
    }
    const share = await lockerContract().tokenProtocolFeeShares(config.tokenAddress);
    console.log('protocolFee:', `${share}% kept by the locker; ${100n - share}% of LP fees is yours`);
  } catch (_e) { /* informational only */ }

  hr('CREATOR FEES + BUY QUOTE');
  const wethBal = await getWethBalanceEth();
  console.log('wallet WETH:', wethBal, '(claimed, unspent buy fuel)');
  const pending = await getPendingCreatorFees();
  if (pending.authorized) {
    console.log('pending    :', pending.weth, 'WETH +', pending.tokens, `${config.tokenSymbol} claimable from the locker`);
  } else {
    console.log('⚠️ collectFees probe reverted:', pending.error);
    console.log('             (either no fees have accrued yet, or this wallet is not allowed to claim)');
  }
  const total = wethBal + pending.weth;
  console.log('fuel total :', +total.toFixed(9), `WETH (a cycle needs ${perCycle})`);

  // Spot-price quote for a real per-cycle buy (read-only) — proves the V3 pool
  // is live and the quote math works.
  const { getEthPriceUsd } = require('../src/evm/price');
  const { quoteSpotOut } = require('../src/evm/swap');
  const { parseEther } = require('ethers');
  const price = await getEthPriceUsd();
  const buyEth =
    config.burnEthPerCycle > 0 ? config.burnEthPerCycle : price > 0 ? config.burnUsdPerCycle / price : 0.001;
  try {
    const out = await quoteSpotOut(parseEther(buyEth.toFixed(9)));
    const decimals = await getDecimals(config.tokenAddress);
    console.log('pool quote :', `${buyEth.toFixed(6)} WETH → ~${formatUnits(out, decimals)} tokens (spot, before fee) ✓ buy path OK`);
  } catch (e) {
    console.log('⚠️ pool quote failed:', e.shortMessage || e.message, '— check TOKEN_ADDRESS');
  }

  console.log('\n✅ preflight complete (no transactions sent)');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ check failed:', e.message);
  process.exit(1);
});
