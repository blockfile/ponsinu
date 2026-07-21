'use strict';

const { formatEther, formatUnits } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const { buyToken } = require('../evm/swap');
const { burnToken } = require('../evm/burn');
const { getPendingCreatorFees, getWalletWeth, collectCreatorFees } = require('../evm/pons');
const { getEthPriceUsd } = require('../evm/price');
const { unwrapWeth, readTokenBalance, getDecimals } = require('../evm/erc20');
const { provider, wallet } = require('../evm/provider');
const simvault = require('../evm/simvault');

/**
 * One claim → buyback → burn cycle (fired by the scheduler every 5 min):
 *
 *   claim the creator share of the locked-LP trading fees from the
 *   PonsLaunchLocker (arrives as WETH + the token itself)
 *     → spend BUY_PCT% of the cycle's WETH buying the token on the V3 pool
 *       (the remainder is the dev cut, kept by the wallet as native ETH)
 *     → BURN the wallet's entire token balance: what was bought PLUS the
 *       claimed token-side fees PLUS any residue (→ DEAD_ADDRESS)
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

    // 1. Size the cycle: a fixed BURN_ETH_PER_CYCLE of WETH (default — no price
    //    feed needed), or BURN_USD_PER_CYCLE at the live price when it's 0.
    //    BUY_PCT% of the cycle funds the buyback; the rest is the dev cut, kept
    //    by the wallet as native ETH.
    let cycleEth = buyEthArg;
    let price = null;
    if (cycleEth == null) {
      if (config.burnEthPerCycle > 0) {
        cycleEth = config.burnEthPerCycle;
      } else {
        price = await getEthPriceUsd();
        if (!(price > 0)) {
          await repo.finishCycle(id, { status: 'skipped', note: 'ETH price unavailable — cannot size the buy' });
          log('skipped: no ETH price');
          return repo.getCycleWithSteps(id);
        }
        cycleEth = config.burnUsdPerCycle / price;
      }
    }
    cycleEth = +cycleEth.toFixed(9);
    const buyEth = +((cycleEth * config.buyPct) / 100).toFixed(9);
    const devEth = +(cycleEth - buyEth).toFixed(9);
    if (!(buyEth > 0)) {
      await repo.finishCycle(id, { status: 'skipped', note: 'buy size resolved to 0' });
      log('skipped: buy size 0');
      return repo.getCycleWithSteps(id);
    }

    // 2. Check the fuel: WETH already in the wallet + creator WETH pending in
    //    the locker must cover the full cycle (buy + dev cut).
    const [pending, walletWeth] = await Promise.all([getPendingCreatorFees(), getWalletWeth()]);
    const spendable = walletWeth + pending.weth;
    if (spendable < cycleEth) {
      const authNote =
        !config.dryRun && !pending.authorized && pending.error
          ? ` (claim probe reverted: ${pending.error} — is this wallet the token's deployer?)`
          : '';
      await repo.finishCycle(id, {
        status: 'skipped',
        eth_spent_buy: 0,
        note: `insufficient fees: ${+walletWeth.toFixed(9)} WETH in wallet + ${+pending.weth.toFixed(9)} pending < ${cycleEth} needed${authNote}`,
      });
      log(`skipped: insufficient fees (${+spendable.toFixed(9)} < ${cycleEth} WETH)`);
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

    // 6. Burn the wallet's ENTIRE token balance (BURN_CLAIMED_TOKENS, default
    //    on): the buyback, the token-side fees every claim delivers, and any
    //    residue from earlier cycles (e.g. a claim whose burn leg failed).
    //    ponsfamily claims pay tokens on every claim — all of it goes to dEaD.
    let burnRaw = BigInt(buy.tokensBoughtRaw);
    let claimedTokensBurned = 0;
    if (config.burnClaimedTokens) {
      if (config.dryRun) {
        const t = simvault.takeTokens();
        claimedTokensBurned = t;
        burnRaw += BigInt(Math.round(t)) * 10n ** 18n;
      } else {
        const walletBal = await readTokenBalance(config.tokenAddress, wallet.address);
        if (walletBal > burnRaw) {
          const decimals = await getDecimals(config.tokenAddress);
          claimedTokensBurned = Number(formatUnits(walletBal - burnRaw, decimals));
          burnRaw = walletBal;
        }
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
    log(`burned ${burn.burned} ${config.tokenSymbol} (${buy.tokensBought} bought + ${claimedTokensBurned} claimed fees/wallet residue) → ${burn.deadAddress}`);

    // 7. Keep the dev cut (the (100 - BUY_PCT)% of the cycle): unwrap it to
    //    native ETH so it stays with the wallet but out of the WETH fuel pool —
    //    otherwise the next tick would just re-spend it on a buyback.
    let devKept = 0;
    if (devEth > 0) {
      if (config.dryRun) {
        simvault.spendWeth(devEth);
        devKept = devEth;
      } else {
        devKept = await unwrapWeth(devEth);
      }
      if (devKept > 0) {
        log(`dev cut: kept ${devKept} WETH as native ETH (${+(100 - config.buyPct).toFixed(4)}% of the cycle)`);
      }
    }

    // 8. Done.
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'claim-buyback-burn',
      eth_claimed: claim ? claim.wethClaimed : 0,
      eth_spent_buy: buyEth,
      eth_dev: devKept,
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
