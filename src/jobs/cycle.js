'use strict';

const { formatEther } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const { buyToken } = require('../evm/swap');
const { burnToken } = require('../evm/burn');
const { getPendingCreatorFees, getWalletWeth, collectCreatorFees } = require('../evm/pons');
const { getEthPriceUsd } = require('../evm/price');
const { unwrapWeth } = require('../evm/erc20');
const { provider, wallet } = require('../evm/provider');
const simvault = require('../evm/simvault');

/**
 * One claim → buyback → burn cycle (fired by the scheduler every 5 min):
 *
 *   claim the creator share of the locked-LP trading fees from the
 *   PonsLaunchLocker (arrives as WETH + the token itself)
 *     → spend BURN_USD_PER_CYCLE worth of WETH buying the token on the V3 pool
 *     → BURN what was bought PLUS the claimed token-side fees (→ DEAD_ADDRESS)
 *
 * The claim leg is skipped when the pending WETH is dust (< CLAIM_MIN_WETH) and
 * the wallet already holds enough WETH for the buy. If wallet + pending WETH
 * together can't fund the buy, the cycle is skipped and retried next tick.
 *
 * @param {number} [buyEthArg] pre-computed buy size in WETH (else derived from
 *   BURN_USD_PER_CYCLE and the live ETH price)
 * @returns {Promise<object>} the persisted cycle (with steps)
 */
async function runCycle(buyEthArg) {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS is required');

    // 1. Size the buy: BURN_USD_PER_CYCLE converted to WETH at the live price.
    let buyEth = buyEthArg;
    let price = null;
    if (buyEth == null) {
      price = await getEthPriceUsd();
      if (!(price > 0)) {
        await repo.finishCycle(id, { status: 'skipped', note: 'ETH price unavailable — cannot size the buy' });
        log('skipped: no ETH price');
        return repo.getCycleWithSteps(id);
      }
      buyEth = config.burnUsdPerCycle / price;
    }
    buyEth = +buyEth.toFixed(9);
    if (!(buyEth > 0)) {
      await repo.finishCycle(id, { status: 'skipped', note: 'buy size resolved to 0' });
      log('skipped: buy size 0');
      return repo.getCycleWithSteps(id);
    }

    // 2. Check the fuel: WETH already in the wallet + creator WETH pending in
    //    the locker must cover the buy.
    const [pending, walletWeth] = await Promise.all([getPendingCreatorFees(), getWalletWeth()]);
    const spendable = walletWeth + pending.weth;
    if (spendable < buyEth) {
      const authNote =
        !config.dryRun && !pending.authorized && pending.error
          ? ` (claim probe reverted: ${pending.error} — is this wallet the token's deployer?)`
          : '';
      await repo.finishCycle(id, {
        status: 'skipped',
        eth_spent_buy: 0,
        note: `insufficient fees: ${+walletWeth.toFixed(9)} WETH in wallet + ${+pending.weth.toFixed(9)} pending < ${buyEth} needed${authNote}`,
      });
      log(`skipped: insufficient fees (${+spendable.toFixed(9)} < ${buyEth} WETH)`);
      return repo.getCycleWithSteps(id);
    }

    // 3. Keep gas alive (live only): fees arrive as WETH, but gas is paid in
    //    native ETH — top the reserve back up from WETH when it runs low.
    if (!config.dryRun) {
      const native = Number(formatEther(await provider.getBalance(wallet.address)));
      if (native < config.gasReserveEth / 2) {
        const unwrapped = await unwrapWeth(config.gasReserveEth);
        log(`gas top-up: unwrapped ${unwrapped} WETH (native was ${native.toFixed(6)} ETH)`);
      }
    }

    // 4. Claim the creator fees — always when the buy needs the pending WETH,
    //    otherwise only once it's worth the gas (≥ CLAIM_MIN_WETH).
    let claim = null;
    const mustClaim = walletWeth < buyEth;
    if (mustClaim || pending.weth >= config.claimMinWeth) {
      claim = await collectCreatorFees();
      await repo.addStep({
        cycleId: id,
        name: 'claim',
        status: 'ok',
        signature: claim.signature,
        detail: {
          ethClaimed: claim.wethClaimed,
          tokensClaimed: claim.tokensClaimed,
          tokensClaimedRaw: claim.tokensClaimedRaw,
        },
      });
      log(`claimed ${claim.wethClaimed} WETH + ${claim.tokensClaimed} ${config.tokenSymbol} from the locker`);
    } else {
      log(`claim skipped: ${+pending.weth.toFixed(9)} WETH pending < ${config.claimMinWeth} min (wallet covers the buy)`);
    }

    // 5. Buy the token with BURN_USD_PER_CYCLE of WETH on the V3 pool.
    log(`buy ${buyEth} WETH${price ? ` (~$${config.burnUsdPerCycle} @ $${Math.round(price)}/ETH)` : ''} of ${config.tokenSymbol}`);
    const buy = await buyToken(config.tokenAddress, buyEth);
    await repo.addStep({ cycleId: id, name: 'buy', status: 'ok', signature: buy.signature, detail: { ethSpent: buyEth, tokensBought: buy.tokensBought } });
    log(`bought ${buy.tokensBought} ${config.tokenSymbol}`);
    if (config.dryRun) simvault.spendWeth(buyEth);

    // 6. Burn everything we just bought, plus the token-side fees the claim
    //    delivered (BURN_CLAIMED_TOKENS, default on).
    let burnRaw = BigInt(buy.tokensBoughtRaw);
    let claimedTokensBurned = 0;
    if (config.burnClaimedTokens && claim) {
      if (config.dryRun) {
        const t = simvault.takeTokens();
        claimedTokensBurned = t;
        burnRaw += BigInt(Math.round(t)) * 10n ** 18n;
      } else if (BigInt(claim.tokensClaimedRaw) > 0n) {
        claimedTokensBurned = claim.tokensClaimed;
        burnRaw += BigInt(claim.tokensClaimedRaw);
      }
    }
    const burn = await burnToken(config.tokenAddress, burnRaw.toString());
    await repo.addStep({
      cycleId: id,
      name: 'burn',
      status: 'ok',
      signature: burn.signature,
      detail: {
        tokensBurned: burn.burned,
        burnedRaw: burn.burnedRaw,
        deadAddress: burn.deadAddress,
        fromBuy: buy.tokensBought,
        fromClaimedFees: claimedTokensBurned,
      },
    });
    log(`burned ${burn.burned} ${config.tokenSymbol} (${buy.tokensBought} bought + ${claimedTokensBurned} claimed fees) → ${burn.deadAddress}`);

    // 7. Done.
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'claim-buyback-burn',
      usd_target: config.burnUsdPerCycle,
      eth_claimed: claim ? claim.wethClaimed : 0,
      eth_spent_buy: buyEth,
      tokens_bought: buy.tokensBought,
      tokens_burned: burn.burned,
      burn_sig: burn.signature,
    });
    log('complete (claim-buyback-burn)');
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle };
