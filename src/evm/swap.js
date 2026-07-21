'use strict';

// Buys the token with WETH through the Uniswap V3 SwapRouter02 — the canonical
// router bound to the same V3 factory the ponsfamily launch pool lives on.
// Creator fees arrive as WETH (ERC-20), so the swap is a plain exactInputSingle
// (WETH → token) on the launch pool's fee tier; no wrapping needed. NOTE the
// SwapRouter02 struct has NO deadline field — the with-deadline signature is
// the classic SwapRouter and reverts here. The minimum-out is sized by
// static-calling the swap itself (real fill: pool fee + price impact included)
// minus SLIPPAGE_PCT, and what actually lands is counted via balance delta.

const { Contract, parseEther, formatEther } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { getDecimals, readTokenBalance, wethContract } = require('./erc20');
const { getLaunchInfo, POOL_ABI } = require('./pons');

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
];

const BUY_ATTEMPTS = 3;
const Q192 = 1n << 192n;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Expected token output for `amountInWei` of WETH at the pool's CURRENT spot
 * price (slot0), before the fee/slippage haircut. Exact in raw units, so token
 * decimals never enter the math. Used by the read-only preflight (which can't
 * static-call the swap — the wallet may hold no WETH yet); buyToken itself
 * quotes by static-calling the swap.
 * @returns {Promise<bigint>}
 */
async function quoteSpotOut(amountInWei) {
  const info = await getLaunchInfo();
  const pool = new Contract(info.pool, POOL_ABI, provider);
  const { sqrtPriceX96 } = await pool.slot0();
  const priceX192 = BigInt(sqrtPriceX96) * BigInt(sqrtPriceX96);
  // price = token1/token0. WETH in → token out.
  return info.wethIsToken0
    ? (amountInWei * priceX192) / Q192 // out is token1
    : (amountInWei * Q192) / priceX192; // out is token0
}

/** Approve the router to pull the wallet's WETH once (max approval, cached on-chain). */
async function ensureRouterAllowance(amountInWei) {
  const weth = wethContract(wallet);
  const current = await weth.allowance(wallet.address, config.swapRouter);
  if (current >= amountInWei) return;
  const tx = await weth.approve(config.swapRouter, (1n << 256n) - 1n);
  await tx.wait();
  console.log(`[tx] approve WETH → SwapRouter02: ${tx.hash}`);
}

/**
 * Buy `token` with `wethAmount` (ETH units) of the wallet's WETH via
 * SwapRouter02 exactInputSingle on the launch pool's fee tier.
 * @returns {Promise<{signature, tokensBought, tokensBoughtRaw, baseDecimals, simulated}>}
 */
async function buyToken(token, wethAmount) {
  if (config.dryRun) {
    const baseDecimals = 18;
    const tokensBought = +(wethAmount * 1_000_000 * (0.97 + Math.random() * 0.06)).toFixed(0);
    return {
      signature: fakeSig('buy'),
      tokensBought,
      tokensBoughtRaw: (BigInt(tokensBought) * 10n ** BigInt(baseDecimals)).toString(),
      baseDecimals,
      simulated: true,
    };
  }

  const amountIn = parseEther(String(wethAmount));
  if (amountIn <= 0n) throw new Error(`invalid buy amount: ${wethAmount}`);
  if (!(config.slippagePct >= 0 && config.slippagePct < 100)) {
    throw new Error(`SLIPPAGE_PCT must be in [0, 100): ${config.slippagePct}`);
  }

  const wethBal = await wethContract().balanceOf(wallet.address);
  if (wethBal < amountIn) {
    throw new Error(
      `insufficient WETH: need ${formatEther(amountIn)}, have ${formatEther(wethBal)} — claim fees first`
    );
  }

  const info = await getLaunchInfo();
  const baseDecimals = await getDecimals(token);
  await ensureRouterAllowance(amountIn);
  const router = new Contract(config.swapRouter, ROUTER_ABI, wallet);

  const params = (amountOutMinimum) => ({
    tokenIn: config.weth,
    tokenOut: token,
    fee: info.poolFee,
    recipient: wallet.address,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  });

  // Re-quote and re-send up to BUY_ATTEMPTS: a one-block price move can revert
  // the send on the min-output check; wait out the spike and retry rather than
  // fail the cycle. The quote is a static call of the swap itself (min-out 0),
  // so the returned fill already includes the pool fee and price impact — only
  // the slippage haircut is applied on top.
  let lastErr;
  for (let attempt = 1; attempt <= BUY_ATTEMPTS; attempt++) {
    let amountOutMin;
    try {
      const quoted = await router.exactInputSingle.staticCall(params(0n));
      if (quoted === 0n) throw new Error('swap quote returned 0 — no pool liquidity?');
      amountOutMin = (quoted * BigInt(Math.round((100 - config.slippagePct) * 100))) / 10_000n;
    } catch (err) {
      throw new Error(`pool quote failed for ${token} (pool ${info.pool}): ${err.shortMessage || err.message}`);
    }

    try {
      const balBefore = await readTokenBalance(token, wallet.address);
      const tx = await router.exactInputSingle(params(amountOutMin));
      await tx.wait();
      console.log(`[tx] buy ${token} with ${wethAmount} WETH via SwapRouter02: ${tx.hash}`);
      const balAfter = await readTokenBalance(token, wallet.address);

      const boughtRaw = balAfter - balBefore;
      return {
        signature: tx.hash,
        tokensBought: Number(boughtRaw) / 10 ** baseDecimals,
        tokensBoughtRaw: boughtRaw.toString(),
        baseDecimals,
        simulated: false,
      };
    } catch (err) {
      lastErr = err;
      console.warn(
        `[buy] attempt ${attempt}/${BUY_ATTEMPTS} reverted — requoting${attempt < BUY_ATTEMPTS ? ' after 3s' : ''}`
      );
      if (attempt < BUY_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

module.exports = { buyToken, quoteSpotOut };
